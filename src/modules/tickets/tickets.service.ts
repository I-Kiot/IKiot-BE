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

/** Tin nhắn trả về cũ nhất trước để đọc từ trên xuống. Bản cũ nhúng mảng nên có sẵn thứ tự; ở đây phải yêu cầu rõ. */
const WITH_MESSAGES = {
  messages: { orderBy: { createdAt: 'asc' } },
} as const;

/** Luồng hỗ trợ giữa shop và operator. Ticket thuộc shop chứ không thuộc người tạo (nên `/tickets/my` lọc theo `tenantId`); `isDeletedByTenant` là cách xoá duy nhất, ẩn với shop nhưng operator vẫn thấy. Route cũ chỉ có `verifyJwt`, nên mọi tài khoản đăng nhập đều đọc hoặc xoá mềm được ticket bất kỳ. */
@Injectable()
export class TicketService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationService,
    private readonly realtime: RealtimeGateway,
  ) {}

  /** Nhãn người gửi trên tin nhắn. JWT cũ không có `profile` hay `email`, nên mọi tin nhắn production từng bị gắn số điện thoại. Ở đây hiển thị đúng vì `JwtStrategy` đọc lại user mỗi request. */
  private senderName(user: AuthUser): string {
    return user.displayName ?? user.email ?? user.phoneNumber;
  }

  async create(tenantId: string, user: AuthUser, dto: CreateTicketDto) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { name: true },
    });
    const tenantName = tenant?.name ?? 'Unknown Store';

    // Bản cũ tái sử dụng mã sau ~16,7 phút trên cột unique; ở đây dùng chung generator với mọi mã tham chiếu khác.
    const ticketId = generateReference(REFERENCE_PREFIX.TICKET);

    // Nội dung mở đầu được lưu hai lần có chủ đích: trên ticket (danh sách đọc từ đây) và là tin nhắn đầu tiên (thread tự đủ nghĩa).
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

  /** Soft delete. Bản cũ set `isDeletedByTenant` bất kể người gọi là ai, nên operator xoá thread cũng ẩn nó khỏi shop. Giữ nguyên hành vi này; bù lại là danh sách admin vẫn hiện thread. */
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

  /** Cố ý không lọc, kể cả thread shop đã xoá: operator cần toàn bộ lịch sử, admin UI hiện thread đã xoá kèm badge. */
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

    // Chủ shop đã tạo ticket rồi quay lại việc kinh doanh, nên event socket chỉ tới khi app đang mở; dòng inbox mới là thứ thực sự tới được họ.
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

  /** Một lần ghi cho tin nhắn và trạng thái theo lượt người gửi. Status luôn được ghi kể cả khi không đổi, để `@updatedAt` tăng và thread lên đầu cả hai danh sách. */
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
