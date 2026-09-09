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

/** The shape every route answers with, restored from iKiotMS-BE. */
export interface ResponseEnvelope {
  success: boolean;
  message?: string;
  data?: unknown;
  [key: string]: unknown;
}

/** Puts iKiotMS-BE's `{ success, message?, data }` envelope back on every response - spread when the body already carries `data`/`success` (so `paginate()` stays flat), wrapped otherwise. Must be provided before AuditInterceptor, which runs after it on the way out. */
@Injectable()
export class ResponseEnvelopeInterceptor implements NestInterceptor<
  unknown,
  unknown
> {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    // Handler first, then class - a controller can opt itself out wholesale.
    const raw = this.reflector.getAllAndOverride<boolean>(RAW_RESPONSE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (raw) return next.handle();

    return next.handle().pipe(map((body) => this.wrap(body)));
  }

  private wrap(body: unknown): unknown {
    // A file download is a stream, not JSON - wrapping it would corrupt the response.
    if (body instanceof StreamableFile) return body;

    if (body === undefined || body === null) return { success: true };

    if (this.isMergeable(body)) {
      return { success: true, ...body } satisfies ResponseEnvelope;
    }

    return { success: true, data: body } satisfies ResponseEnvelope;
  }

  /** Does this body already speak the envelope's language? Plain objects only - a Date or a Prisma Decimal would lose its prototype to the spread. */
  private isMergeable(body: unknown): body is Record<string, unknown> {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return false;
    }
    const proto: unknown = Object.getPrototypeOf(body);
    if (proto !== Object.prototype && proto !== null) return false;
    return 'data' in body || 'success' in body;
  }
}
