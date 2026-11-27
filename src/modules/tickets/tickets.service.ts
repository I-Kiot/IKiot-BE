import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationService } from '../notifications/notifications.service';
import { TicketNotificationTemplates } from '../notifications/templates/ticket.templates';
import { RealtimeGateway } from '../../common/realtime/realtime.gateway';
import { SystemRole } from '../../common/constants/system-role';
import {
  generateReference,
  REFERENCE_PREFIX,
} from '../../common/utils/reference-generator';
import {
  paginate,
  skipFor,
  type Paginated,
} from '../../common/utils/pagination';
import type { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import type { AuthUser } from '../../common/types/auth-user.type';
import type { CreateTicketDto, ReplyTicketDto } from './dto/ticket.dto';
import { DEFAULT_TICKET_PRIORITY, TicketStatus } from './ticket.constants';
import { ErrorCode } from '../../common/errors/error-codes';

/** Tin nhắn cũ nhất trước. */
const WITH_MESSAGES = {
  messages: { orderBy: { createdAt: 'asc' } },
} as const;

/** Ticket hỗ trợ giữa shop và admin; shop xoá là ẩn. */
@Injectable()
export class TicketService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationService,
    private readonly realtime: RealtimeGateway,
  ) {}

  /** Nhãn người gửi tin nhắn. */
  private senderName(user: AuthUser): string {
    return user.displayName ?? user.email ?? user.phoneNumber;
  }

  async create(tenantId: string, user: AuthUser, dto: CreateTicketDto) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { name: true },
    });
    const tenantName = tenant?.name ?? 'Unknown Store';

    // Sinh mã ticket.
    const ticketId = generateReference(REFERENCE_PREFIX.TICKET);

    // Lưu nội dung mở đầu trên ticket và là tin nhắn đầu.
    const ticket = await this.prisma.ticket.create({
      data: {
        ticketId,
        tenantId,
        tenantName,
        userId: user.userId,
        title: dto.title,
        description: dto.description,
        priority: dto.priority ?? DEFAULT_TICKET_PRIORITY,
        status: TicketStatus.OPEN,
        messages: {
          create: [
            {
              senderId: user.userId,
              senderName: this.senderName(user),
              senderRole: user.systemRole,
              message: dto.description,
            },
          ],
        },
      },
      include: WITH_MESSAGES,
    });

    await this.notifications.notifySystem({
      ...TicketNotificationTemplates.created(tenantName, ticketId, dto.title),
      referenceId: ticket.id,
    });
    this.realtime.emitToRoom('admin', 'ticket-update', ticket);

    return ticket;
  }

  findMine(tenantId: string) {
    return this.prisma.ticket.findMany({
      where: { tenantId, isDeletedByTenant: false },
      orderBy: { updatedAt: 'desc' },
      include: WITH_MESSAGES,
    });
  }

  async replyMine(
    tenantId: string,
    user: AuthUser,
    id: string,
    dto: ReplyTicketDto,
  ) {
    const existing = await this.prisma.ticket.findFirst({
      where: { id, tenantId },
      select: { status: true },
    });
    if (!existing)
      throw new NotFoundException({
        code: ErrorCode.TICKET_NOT_FOUND,
        message: 'Support ticket not found',
      });
    if (existing.status === TicketStatus.CLOSED) {
      throw new BadRequestException({
        code: ErrorCode.TICKET_CLOSED,
        message: 'A closed ticket cannot be replied to',
      });
    }

    // Shop vừa nhắn nên đưa về OPEN để operator xử lý lại.
    const ticket = await this.appendMessage(
      id,
      user,
      dto.message,
      TicketStatus.OPEN,
    );

    this.realtime.emitToRoom('admin', 'ticket-update', ticket);
    return ticket;
  }

  async findOne(user: AuthUser, id: string) {
    const ticket = await this.prisma.ticket.findUnique({
      where: { id },
      include: WITH_MESSAGES,
    });
    if (!ticket)
      throw new NotFoundException({
        code: ErrorCode.TICKET_NOT_FOUND,
        message: 'Support ticket not found',
      });
    this.assertCanReach(user, ticket.tenantId);
    return ticket;
  }

  /** Xoá mềm ticket. */
  async remove(user: AuthUser, id: string) {
    const found = await this.prisma.ticket.findUnique({
      where: { id },
      select: { tenantId: true },
    });
    if (!found)
      throw new NotFoundException({
        code: ErrorCode.TICKET_NOT_FOUND,
        message: 'Support ticket not found',
      });
    this.assertCanReach(user, found.tenantId);

    const ticket = await this.prisma.ticket.update({
      where: { id },
      data: { isDeletedByTenant: true, deletedAt: new Date() },
      include: WITH_MESSAGES,
    });

    // Hai event khác nhau: danh sách shop bỏ dòng này, danh sách admin hiển thị lại với badge "đã xoá".
    this.realtime.emitToRoom(`tenant:${ticket.tenantId}`, 'ticket-delete', {
      id,
    });
    this.realtime.emitToRoom('admin', 'ticket-update', ticket);

    return { message: 'Đã xoá yêu cầu hỗ trợ', data: ticket };
  }

  /** Danh sách ticket cho admin, kể cả đã xoá. */
  async findAllAdmin(query: PaginationQueryDto) {
    const { page, limit } = query;
    const [tickets, total] = await Promise.all([
      this.prisma.ticket.findMany({
        orderBy: { updatedAt: 'desc' },
        skip: skipFor(page, limit),
        take: limit,
        include: WITH_MESSAGES,
      }),
      this.prisma.ticket.count(),
    ]);
    return paginate(tickets, total, page, limit) satisfies Paginated<unknown>;
  }

  async replyAdmin(user: AuthUser, id: string, dto: ReplyTicketDto) {
    await this.assertExists(id);

    const ticket = await this.appendMessage(
      id,
      user,
      dto.message,
      TicketStatus.IN_PROGRESS,
    );

    this.realtime.emitToRoom('admin', 'ticket-update', ticket);
    this.realtime.emitToRoom(
      `tenant:${ticket.tenantId}`,
      'ticket-update',
      ticket,
    );

    // Ghi vào hộp thư cho chủ shop.
    const owners = await this.notifications.tenantOwners(ticket.tenantId);
    await this.notifications.notify({
      tenantId: ticket.tenantId,
      recipientIds: owners,
      ...TicketNotificationTemplates.replied(ticket.title),
      referenceId: ticket.id,
    });

    return ticket;
  }

  async closeAdmin(id: string) {
    await this.assertExists(id);

    const ticket = await this.prisma.ticket.update({
      where: { id },
      data: { status: TicketStatus.CLOSED },
      include: WITH_MESSAGES,
    });

    this.realtime.emitToRoom('admin', 'ticket-update', ticket);
    this.realtime.emitToRoom(
      `tenant:${ticket.tenantId}`,
      'ticket-update',
      ticket,
    );

    return ticket;
  }

  /** Ghi tin nhắn và trạng thái ticket. */
  private appendMessage(
    id: string,
    user: AuthUser,
    message: string,
    status: string,
  ) {
    return this.prisma.ticket.update({
      where: { id },
      data: {
        status,
        messages: {
          create: {
            senderId: user.userId,
            senderName: this.senderName(user),
            senderRole: user.systemRole,
            message,
          },
        },
      },
      include: WITH_MESSAGES,
    });
  }

  private async assertExists(id: string): Promise<void> {
    const found = await this.prisma.ticket.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!found)
      throw new NotFoundException({
        code: ErrorCode.TICKET_NOT_FOUND,
        message: 'Support ticket not found',
      });
  }

  private assertCanReach(user: AuthUser, ownerTenantId: string): void {
    if (user.systemRole === SystemRole.ADMIN) return;
    if (user.tenantId !== ownerTenantId) {
      throw new ForbiddenException({
        code: ErrorCode.TICKET_ACCESS_DENIED,
        message: 'You have no access to this support ticket',
      });
    }
  }
}
