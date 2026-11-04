import {
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import type { Prisma } from '../../../generated/prisma/client';
import { requireTenantId } from '../../common/utils/tenant-scope';
import { paginate, skipFor } from '../../common/utils/pagination';
import type { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import type { AuthUser } from '../../common/types/auth-user.type';
import { AiAgentService } from './ai-agent.service';
import { AiToolsService } from './ai-tools.service';
import type { Content } from './gemini.client';
import {
  FALLBACK_REPLY,
  ROUTING_HISTORY_MESSAGES,
  TITLE_MAX_LENGTH,
} from './ai-chat.constants';
import type { ChatDto, RenameConversationDto } from './dto/ai-chat.dto';
import { ErrorCode } from '../../common/errors/error-codes';

/** Một lượt đã lưu. Khớp shape của Gemini để transcript phát lại không cần map. */
interface StoredMessage {
  role: 'user' | 'model';
  parts: { text: string }[];
  createdAt: string;
}

/** Hội thoại với trợ lý, port từ AIService: transcript là cột jsonb đọc nguyên khối, chỉ chứa `{ role, parts }`; mọi truy vấn lọc theo cả tenant và user. */
@Injectable()
export class AIChatHistoryService {
  private readonly logger = new Logger(AIChatHistoryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly agent: AiAgentService,
    private readonly tools: AiToolsService,
  ) {}

  async chat(user: AuthUser, dto: ChatDto) {
    const tenantId = requireTenantId(user);

    if (!this.agent.isConfigured()) {
      // Trả 503 chứ không trả câu fallback thân thiện: API key chưa set là lỗi của operator; giấu trong bong bóng chat thì lỗi sẽ không ai sửa.
      throw new ServiceUnavailableException({
        code: ErrorCode.AI_NOT_CONFIGURED,
        message: 'The AI assistant is not configured on this server',
      });
    }

    const conversation = await this.findOrStart(tenantId, user.userId, dto);
    const history = this.messagesOf(conversation);

    const contents: Content[] = [
      ...history.map((message) => ({
        role: message.role,
        parts: message.parts.map((part) => ({ text: part.text })),
      })),
      { role: 'user' as const, parts: [{ text: dto.message }] },
    ];

    let reply = FALLBACK_REPLY;
    try {
      const route = await this.agent.classify(
        this.summarize(history),
        dto.message,
      );
      const result = await this.agent.run(contents, route, (name, args) =>
        this.tools.run(user, name, args),
      );
      reply = result.answer || FALLBACK_REPLY;
      this.logger.debug(
        `Answered in ${result.steps} step(s) on route ${result.route}`,
      );
    } catch (error) {
      // Transcript luôn được lưu, kể cả khi lỗi: câu hỏi không có câu trả lời đi kèm trông như chưa từng được gửi.
      this.logger.error(
        'Chat execution failed',
        error instanceof Error ? error.stack : error,
      );
    }

    const saved = await this.append(
      conversation.id,
      history,
      dto.message,
      reply,
    );

    return {
      reply,
      conversationId: saved.id,
      title: saved.title,
    };
  }

  /** `conversationId` không tồn tại hoặc không gửi thì mở thread mới thay vì báo lỗi. */
  private async findOrStart(tenantId: string, userId: string, dto: ChatDto) {
    if (dto.conversationId) {
      const existing = await this.prisma.aIChatHistory.findFirst({
        where: { id: dto.conversationId, tenantId, userId },
      });
      if (existing) return existing;
    }

    const title =
      dto.message.length > TITLE_MAX_LENGTH
        ? `${dto.message.slice(0, TITLE_MAX_LENGTH)}...`
        : dto.message;

    return this.prisma.aIChatHistory.create({
      data: { tenantId, userId, title, messages: [] },
    });
  }

  private async append(
    id: string,
    history: StoredMessage[],
    question: string,
    answer: string,
  ) {
    const now = new Date().toISOString();
    const messages: StoredMessage[] = [
      ...history,
      { role: 'user', parts: [{ text: question }], createdAt: now },
      { role: 'model', parts: [{ text: answer }], createdAt: now },
    ];
    return this.prisma.aIChatHistory.update({
      where: { id },
      // Cột Json nên Prisma cần InputJsonValue; shape thì khớp, chỉ là TypeScript không nhận ra.
      data: { messages: messages as unknown as Prisma.InputJsonValue },
    });
  }

  /** Vài lượt gần nhất, nối thành text, dùng cho prompt phân loại. */
  private summarize(history: StoredMessage[]): string {
    return history
      .slice(-ROUTING_HISTORY_MESSAGES)
      .map(
        (message) =>
          `${message.role === 'user' ? 'User' : 'AI'}: ${message.parts
            .map((part) => part.text)
            .join('')}`,
      )
      .join('\n');
  }

  /** `messages` là Json: row do phiên bản cũ ghi phải được coi là lịch sử rỗng, không làm crash request. */
  private messagesOf(row: { messages: unknown }): StoredMessage[] {
    if (!Array.isArray(row.messages)) return [];
    return row.messages.filter(
      (message): message is StoredMessage =>
        typeof message === 'object' &&
        message !== null &&
        'role' in message &&
        Array.isArray((message as StoredMessage).parts),
    );
  }

  /** Chỉ lấy tiêu đề; transcript được lấy từng cuộc một. */
  async findAll(user: AuthUser, query: PaginationQueryDto) {
    const tenantId = requireTenantId(user);
    const where = { tenantId, userId: user.userId };
    const { page, limit } = query;

    const [rows, total] = await Promise.all([
      this.prisma.aIChatHistory.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip: skipFor(page, limit),
        take: limit,
        select: { id: true, title: true, updatedAt: true, createdAt: true },
      }),
      this.prisma.aIChatHistory.count({ where }),
    ]);

    return paginate(rows, total, page, limit);
  }

  async findOne(user: AuthUser, id: string) {
    const conversation = await this.prisma.aIChatHistory.findFirst({
      where: { id, tenantId: requireTenantId(user), userId: user.userId },
    });
    if (!conversation) {
      throw new NotFoundException({
        code: ErrorCode.AI_CONVERSATION_NOT_FOUND,
        message: 'Conversation not found',
      });
    }
    return conversation;
  }

  async rename(user: AuthUser, id: string, dto: RenameConversationDto) {
    await this.findOne(user, id);
    return this.prisma.aIChatHistory.update({
      where: { id },
      data: { title: dto.title },
    });
  }

  async remove(user: AuthUser, id: string) {
    const { count } = await this.prisma.aIChatHistory.deleteMany({
      where: { id, tenantId: requireTenantId(user), userId: user.userId },
    });
    if (count === 0) {
      throw new NotFoundException({
        code: ErrorCode.AI_CONVERSATION_NOT_FOUND,
        message: 'Conversation not found',
      });
    }
    return { message: 'Đã xoá cuộc hội thoại' };
  }
}
