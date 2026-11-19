import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { Observable, tap } from 'rxjs';
import { PrismaService } from '../../prisma/prisma.service';
import { SOCKET_ID_HEADER } from '../constants/change-feed';
import type { AuthUser } from '../types/auth-user.type';
import { actorOf } from './change-feed';
import { ChangeFeedService } from './change-feed.service';
import type {
  ChangeExtractContext,
  ChangeSpec,
  ChangeTarget,
} from './change-feed.types';
import { readRef } from './change-ref';
import { EMITS_CHANGE_KEY } from './emits-change.decorator';

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const SOCKET_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

type AuthedRequest = Request & { user?: AuthUser };

/**
 * Phát `entity:changed` sau mỗi handler có `@EmitsChange` thành công. Đăng ký SAU `AuditInterceptor` nên là lớp trong cùng, thấy body thô của handler (chưa bọc envelope).
 * Chỉ phát khi observable phát giá trị: lỗi làm observable lỗi nên `tap.next` không chạy, và handler đã resolve nghĩa là `$transaction` của service đã commit.
 * Việc phát là fire-and-forget và không bao giờ đổi hay làm chậm response.
 */
@Injectable()
export class ChangeFeedInterceptor implements NestInterceptor {
  private readonly logger = new Logger(ChangeFeedInterceptor.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly changeFeed: ChangeFeedService,
    private readonly prisma: PrismaService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const spec = this.reflector.get<ChangeSpec | undefined>(
      EMITS_CHANGE_KEY,
      context.getHandler(),
    );
    if (!spec) return next.handle();

    const request = context.switchToHttp().getRequest<AuthedRequest>();
    if (!WRITE_METHODS.has(request.method)) return next.handle();
    const user = request.user;
    // ADMIN ghi mà không có tenant thì không có room để phát tới.
    const tenantId = user?.tenantId;
    if (!user || !tenantId) return next.handle();

    const header = request.headers?.[SOCKET_ID_HEADER];
    const exceptSocketId =
      typeof header === 'string' && SOCKET_ID_PATTERN.test(header)
        ? header
        : null;

    return next.handle().pipe(
      tap((body: unknown) => {
        void this.emit(
          spec,
          {
            body,
            params: stringParams(request.params),
            tenantId,
            prisma: this.prisma,
          },
          user,
          exceptSocketId,
        );
      }),
    );
  }

  private async emit(
    spec: ChangeSpec,
    ctx: ChangeExtractContext,
    user: AuthUser,
    exceptSocketId: string | null,
  ): Promise<void> {
    try {
      const target = await (spec.extract ?? defaultExtract)(ctx);
      if (!target?.subjectId) {
        this.logger.warn(`@EmitsChange(${spec.action}) found no subject id`);
        return;
      }
      this.changeFeed.publish({
        tenantId: ctx.tenantId,
        spec,
        target,
        actor: actorOf(user),
        exceptSocketId,
      });
    } catch (error) {
      this.logger.error(
        `Failed to emit ${spec.action}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}

/** Param route có thể là mảng (wildcard); extractor chỉ cần chuỗi. */
function stringParams(
  params: Record<string, string | string[]> | undefined,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(params ?? {})) {
    out[key] = typeof value === 'string' ? value : undefined;
  }
  return out;
}

/** Mặc định: id lấy từ `:id` trên route, không có thì từ `body.id`; mã lấy từ `body.code`. */
function defaultExtract({ body, params }: ChangeExtractContext): ChangeTarget {
  const ref = readRef(body);
  return { subjectId: params.id ?? ref?.id ?? null, code: ref?.code ?? null };
}
