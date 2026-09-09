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

/** Messages come back oldest-first so the thread reads top-to-bottom; the old embedded array got insertion order for free, here it has to be asked for. */
const WITH_MESSAGES = {
  messages: { orderBy: { createdAt: 'asc' } },
} as const;

/** Support threads between a shop and the platform operators. Two things carried over unchanged: a ticket belongs to the shop rather than the person who filed it (so `/tickets/my` filters on `tenantId`), and `isDeletedByTenant` is the only delete - it hides the thread from the shop while operators keep seeing it. What changed: the old routes ran on bare `verifyJwt`, so any authenticated account could read or soft-delete any ticket it could name. */
@Injectable()
export class TicketService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationService,
    private readonly realtime: RealtimeGateway,
  ) {}

  /** How a sender is labelled on a message. The expression is ported as written, but the old JWT payload carried neither `profile` nor `email`, so every production message is stamped with a phone number; it resolves properly here only because `JwtStrategy` re-reads the user each request. */
  private senderName(user: AuthUser): string {
    return user.displayName ?? user.email ?? user.phoneNumber;
  }

  // ─── Shop side ─────────────────────────────────────────────────────────────

  async create(tenantId: string, user: AuthUser, dto: CreateTicketDto) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { name: true },
    });
    const tenantName = tenant?.name ?? 'Unknown Store';

    // The old scheme recycled every ~16.7 minutes against a unique column; this is the same generator every other reference code uses.
    const ticketId = generateReference(REFERENCE_PREFIX.TICKET);

    // The opening description is stored twice on purpose: on the ticket, where the list view reads it, and as the first message, so the thread is self-contained.
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

  /** Every thread the shop can still see, most recently active first. */
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

    // Back to OPEN: the shop has said something, so the thread needs an operator again.
    const ticket = await this.appendMessage(
      id,
      user,
      dto.message,
      TicketStatus.OPEN,
    );

    this.realtime.emitToRoom('admin', 'ticket-update', ticket);
    return ticket;
  }

  // ─── Shared by both sides ──────────────────────────────────────────────────

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

  /** Soft delete. The old controller set `isDeletedByTenant` whoever the caller was, so an operator deleting a thread also hides it from the shop - ported as-is, with the admin list as the counterweight. */
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

    // Two different events: the shop's list drops the row, the admin's list re-renders it with a "deleted" badge.
    this.realtime.emitToRoom(`tenant:${ticket.tenantId}`, 'ticket-delete', {
      id,
    });
    this.realtime.emitToRoom('admin', 'ticket-update', ticket);

    return { message: 'Đã xoá yêu cầu hỗ trợ', data: ticket };
  }

  // ─── Operator side ─────────────────────────────────────────────────────────

  /** Deliberately unfiltered, including threads the shop has deleted - operators need the whole history, and the admin UI renders deleted ones with a badge. */
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

    // The owner filed this and went back to running a shop, so the socket event only lands if the app is open - the inbox row is what actually reaches them.
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

  // ─── Internals ─────────────────────────────────────────────────────────────

  /** One write for the message plus the status the sender's turn implies. The status is always written even when unchanged, so `@updatedAt` bumps and the thread rises to the top of both lists. */
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

  /** A platform operator reaches every thread; anyone else only their own shop's. */
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
