import { Injectable, Logger } from '@nestjs/common';
import type { BatchResponse, SendResponse } from 'firebase-admin/messaging';
import { PrismaService } from '../../prisma/prisma.service';
import { FirebaseService } from '../firebase/firebase.service';

export interface PushPayload {
  title: string;
  body: string;
  /** Extra keys the client reads on tap. Values are coerced to strings - FCM requires it. */
  data?: Record<string, string | null | undefined>;
  /** Where a web push should navigate when clicked. */
  link?: string;
}

export interface PushResult {
  sent: number;
  failed: number;
}

/** FCM's own cap on one `sendEachForMulticast` call - exceeding it rejects the whole batch. */
const FCM_MULTICAST_LIMIT = 500;

/** Codes that mean the registration is gone for good; everything else is transient and must not delete anything. */
const DEAD_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
]);

/** Whether an error means the *token* is dead: FCM v1 answers a malformed token with the generic `invalid-argument`, which a malformed payload also returns, so this prunes only when the message blames the token. */
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

/** Push delivery for users who are not looking at the app - the third leg of `notify()`, and like the others it never throws. */
@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly firebase: FirebaseService,
  ) {}

  /** Send one notification to every device registered to any of `userIds`; a user with no registered device contributes no tokens. */
  async sendToUsers(
    userIds: (string | null | undefined)[],
    payload: PushPayload,
  ): Promise<PushResult> {
    try {
      const messaging = this.firebase.messaging();
      if (!messaging) {
        // Debug, not warn: on a deployment that deliberately leaves Firebase unset this would fire on every notification.
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

      // FCM data values must all be strings; null/undefined is dropped rather than sent as the literal "null".
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

  // Drop the registrations FCM reports gone; deleting by token alone is safe because `token` is unique across the table.
  private async pruneDeadTokens(tokens: string[]): Promise<void> {
    if (tokens.length === 0) return;
    const { count } = await this.prisma.userFcmToken.deleteMany({
      where: { token: { in: tokens } },
    });
    if (count > 0) this.logger.log(`Pruned ${count} dead FCM token(s)`);
  }
}

/** Which of `tokens` the responses say are permanently dead - exported so that decision can be unit-tested without Firebase. */
export function deadTokensIn(
  tokens: string[],
  responses: Pick<SendResponse, 'success' | 'error'>[],
): string[] {
  return tokens.filter((_token, index) =>
    isDeadTokenError(responses[index]?.error),
  );
}

/** Split into runs of at most `size`. */
export function chunk<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}
