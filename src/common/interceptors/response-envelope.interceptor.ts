import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  StreamableFile,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, map } from 'rxjs';
import { RAW_RESPONSE_KEY } from '../decorators/raw-response.decorator';

/** Hình dạng mọi route trả về, khôi phục từ iKiotMS-BE. */
export interface ResponseEnvelope {
  success: boolean;
  message?: string;
  data?: unknown;
  [key: string]: unknown;
}

/** Bọc response thành envelope `{ success, message?, data }`. Nếu body đã có `data`/`success` thì spread để `paginate()` giữ phẳng. Phải đứng trước AuditInterceptor vì nó chạy sau trên đường ra. */
@Injectable()
export class ResponseEnvelopeInterceptor implements NestInterceptor<
  unknown,
  unknown
> {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    // Handler trước, rồi tới class - controller có thể tự bỏ envelope cả lớp.
    const raw = this.reflector.getAllAndOverride<boolean>(RAW_RESPONSE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (raw) return next.handle();

    return next.handle().pipe(map((body) => this.wrap(body)));
  }

  private wrap(body: unknown): unknown {
    // Tải file là stream, không phải JSON - bọc lại sẽ làm hỏng response.
    if (body instanceof StreamableFile) return body;

    if (body === undefined || body === null) return { success: true };

    if (this.isMergeable(body)) {
      return { success: true, ...body } satisfies ResponseEnvelope;
    }

    return { success: true, data: body } satisfies ResponseEnvelope;
  }

  /** Body này đã mang dạng envelope chưa? Chỉ object thuần - Date hay Prisma Decimal sẽ mất prototype khi spread. */
  private isMergeable(body: unknown): body is Record<string, unknown> {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return false;
    }
    const proto: unknown = Object.getPrototypeOf(body);
    if (proto !== Object.prototype && proto !== null) return false;
    return 'data' in body || 'success' in body;
  }
}
