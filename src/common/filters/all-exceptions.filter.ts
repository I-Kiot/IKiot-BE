import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Prisma } from '../../../generated/prisma/client';
import { ErrorCode } from '../errors/error-codes';

/** The one place an unhandled error becomes an HTTP response: Prisma and other non-HttpExceptions get real status codes, and the `{ success: false, code?, message, errors? }` half of the envelope is built here. */
const ERROR_LABELS: Record<number, string> = {
  [HttpStatus.BAD_REQUEST]: 'Bad Request',
  [HttpStatus.NOT_FOUND]: 'Not Found',
  [HttpStatus.CONFLICT]: 'Conflict',
};

/**
 * The failure half of the response envelope. `code` is the stable half of the contract -
 * see `ErrorCode`. It is absent only when an `HttpException` was raised with a bare string
 * body, which now means it came from the framework rather than from this codebase; a client
 * that finds no `code` falls back to `statusCode`.
 */
interface ErrorEnvelope {
  success: false;
  statusCode: number;
  code?: string;
  message: string;
  error?: string;
  errors?: unknown;
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      response
        .status(status)
        .json(this.envelopeOf(status, exception.getResponse()));
      return;
    }

    const translated = this.translatePrismaError(exception);
    if (translated) {
      response.status(translated.statusCode).json({
        success: false,
        ...translated,
      } satisfies ErrorEnvelope);
      return;
    }

    // A bug, not a client mistake: log the stack and answer with nothing that could leak an internal message.
    this.logger.error(
      `Unhandled ${request.method} ${request.originalUrl ?? request.url}`,
      exception instanceof Error ? exception.stack : String(exception),
    );
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      success: false,
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      code: ErrorCode.INTERNAL_ERROR,
      message: 'Something went wrong, please try again later',
      error: 'Internal Server Error',
    } satisfies ErrorEnvelope);
  }

  /** An HttpException's body in the envelope: the ValidationPipe's `message` array moves to `errors`, and any other extra keys pass through. */
  private envelopeOf(statusCode: number, body: unknown): ErrorEnvelope {
    if (typeof body === 'string') {
      return { success: false, statusCode, message: body };
    }
    if (typeof body !== 'object' || body === null) {
      return {
        success: false,
        statusCode,
        code: ErrorCode.BAD_REQUEST,
        message: 'Invalid request',
      };
    }

    const { message, ...rest } = body as Record<string, unknown>;

    if (Array.isArray(message)) {
      return {
        success: false,
        code: ErrorCode.VALIDATION_FAILED,
        ...rest,
        statusCode,
        message: 'The submitted data is invalid',
        errors: message,
      };
    }

    return {
      success: false,
      ...rest,
      statusCode,
      message: typeof message === 'string' ? message : 'Invalid request',
    };
  }

  /** The Prisma error codes this app can actually provoke; anything unlisted keeps falling through to a 500. */
  private translatePrismaError(exception: unknown): {
    statusCode: number;
    code: string;
    message: string;
    error: string;
  } | null {
    if (exception instanceof Prisma.PrismaClientValidationError) {
      // Wrong shape handed to Prisma - a bad query built from client input.
      return this.body(
        HttpStatus.BAD_REQUEST,
        ErrorCode.VALIDATION_FAILED,
        'The submitted data is invalid',
      );
    }

    if (!(exception instanceof Prisma.PrismaClientKnownRequestError)) {
      return null;
    }

    switch (exception.code) {
      case 'P2002':
        return this.body(
          HttpStatus.CONFLICT,
          ErrorCode.UNIQUE_VIOLATION,
          `Value already exists${this.fieldsOf(exception)}`,
        );
      case 'P2003':
        return this.body(
          HttpStatus.BAD_REQUEST,
          ErrorCode.FOREIGN_KEY_VIOLATION,
          'The related record does not exist, or is still in use',
        );
      case 'P2025':
        return this.body(
          HttpStatus.NOT_FOUND,
          ErrorCode.RECORD_NOT_FOUND,
          'The record to operate on was not found',
        );
      case 'P2000':
        return this.body(
          HttpStatus.BAD_REQUEST,
          ErrorCode.VALUE_TOO_LONG,
          'A value exceeds the maximum allowed length',
        );
      case 'P2011':
        return this.body(
          HttpStatus.BAD_REQUEST,
          ErrorCode.REQUIRED_FIELD_MISSING,
          'A required field is missing',
        );
      case 'P2014':
        return this.body(
          HttpStatus.BAD_REQUEST,
          ErrorCode.RELATION_VIOLATION,
          'This operation violates a relation constraint',
        );
      default:
        return null;
    }
  }

  /** `P2002` carries the column(s) that collided - worth showing, it names the field. */
  private fieldsOf(exception: Prisma.PrismaClientKnownRequestError): string {
    const target = (exception.meta as { target?: unknown } | undefined)?.target;
    if (Array.isArray(target)) return `: ${target.join(', ')}`;
    if (typeof target === 'string') return `: ${target}`;
    return '';
  }

  /** Same three-key shape Nest's own HttpException responses use. */
  private body(statusCode: number, code: string, message: string) {
    return {
      statusCode,
      code,
      message,
      error: ERROR_LABELS[statusCode] ?? 'Error',
    };
  }
}
