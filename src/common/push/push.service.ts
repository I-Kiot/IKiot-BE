import { Injectable, Logger } from '@nestjs/common';
import type { BatchResponse, SendResponse } from 'firebase-admin/messaging';
import { PrismaService } from '../../prisma/prisma.service';
import { FirebaseService } from '../firebase/firebase.service';

export interface PushPayload {
  title: string;
  body: string;
  /** Key thêm mà client đọc khi người dùng bấm. Giá trị bị ép thành string vì FCM bắt buộc. */
  data?: Record<string, string | null | undefined>;
  /** Đường dẫn web push mở khi bấm. */
  link?: string;
}

export interface PushResult {
  sent: number;
  failed: number;
}

/** Giới hạn của FCM cho một lần `sendEachForMulticast`; vượt quá là từ chối cả batch. */
const FCM_MULTICAST_LIMIT = 500;

/** Các mã nghĩa là đăng ký đã mất vĩnh viễn; mọi lỗi khác là tạm thời và không được xoá gì. */
const DEAD_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
]);

/** Lỗi có nghĩa là *token* đã chết không? FCM v1 trả `invalid-argument` chung cho token sai định dạng, payload sai cũng trả mã này; nên chỉ xoá khi thông báo nêu đích danh token. */
function isDeadTokenError(error?: {
  code?: string;
  message?: string;
}): boolean {
  if (!error?.code) return false;
  if (DEAD_TOKEN_CODES.has(error.code)) return true;
  return (
    error.code === 'messaging/invalid-argument' &&
    /registration token/i.test(error.message ?? '')
  );
}

/** Gửi push cho người dùng không mở app - là nhánh thứ ba của `notify()`, và như hai nhánh kia, không bao giờ throw. */
@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly firebase: FirebaseService,
  ) {}

  /** Gửi một thông báo tới mọi thiết bị đã đăng ký của bất kỳ `userIds` nào; user chưa có thiết bị thì không đóng góp token nào. */
  async sendToUsers(
    userIds: (string | null | undefined)[],
    payload: PushPayload,
  ): Promise<PushResult> {
    try {
      const messaging = this.firebase.messaging();
      if (!messaging) {
        // Dùng debug, không phải warn: trên môi trường cố tình không cấu hình Firebase, warn sẽ bắn cho mọi thông báo.
        this.logger.debug('Skipped: Firebase Admin is not configured');
        return { sent: 0, failed: 0 };
      }

      const ids = [
        ...new Set(userIds.filter((id): id is string => Boolean(id))),
      ];
      if (ids.length === 0) return { sent: 0, failed: 0 };

      const rows = await this.prisma.userFcmToken.findMany({
        where: { userId: { in: ids } },
        select: { token: true },
      });
      const tokens = rows.map((row) => row.token);
      if (tokens.length === 0) return { sent: 0, failed: 0 };

      // Giá trị data của FCM phải đều là string; null/undefined bị bỏ thay vì gửi thành chữ "null".
      const data = Object.fromEntries(
        Object.entries(payload.data ?? {})
          .filter(([, value]) => value !== null && value !== undefined)
          .map(([key, value]) => [key, String(value)]),
      );

      let sent = 0;
      let failed = 0;
      const dead: string[] = [];

      for (const batch of chunk(tokens, FCM_MULTICAST_LIMIT)) {
        const response: BatchResponse = await messaging.sendEachForMulticast({
          tokens: batch,
          notification: { title: payload.title, body: payload.body },
          data,
          webpush: payload.link
            ? { fcmOptions: { link: payload.link } }
            : undefined,
        });
        sent += response.successCount;
        failed += response.failureCount;
        dead.push(...deadTokensIn(batch, response.responses));
      }

      await this.pruneDeadTokens(dead);
      return { sent, failed };
    } catch (error) {
      this.logger.error(
        'Push delivery failed',
        error instanceof Error ? error.stack : error,
      );
      return { sent: 0, failed: 0 };
    }
  }

  // Xoá các đăng ký mà FCM báo đã mất; xoá theo token là an toàn vì `token` là duy nhất trong cả bảng.
  private async pruneDeadTokens(tokens: string[]): Promise<void> {
    if (tokens.length === 0) return;
    const { count } = await this.prisma.userFcmToken.deleteMany({
      where: { token: { in: tokens } },
    });
    if (count > 0) this.logger.log(`Pruned ${count} dead FCM token(s)`);
  }
}

/** Trong `tokens`, những token mà response nói là chết vĩnh viễn - export để quyết định này unit test được mà không cần Firebase. */
export function deadTokensIn(
  tokens: string[],
  responses: Pick<SendResponse, 'success' | 'error'>[],
): string[] {
  return tokens.filter((_token, index) =>
    isDeadTokenError(responses[index]?.error),
  );
}

/** Chia thành các đoạn có tối đa `size` phần tử. */
export function chunk<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}
