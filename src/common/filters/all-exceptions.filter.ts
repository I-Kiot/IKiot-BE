import { Catch, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Prisma } from '../../../generated/prisma/client';
import { ErrorCode } from '../errors/error-codes';
import { SentryExceptionCaptured } from '@sentry/nestjs';

/** Nơi duy nhất biến lỗi thành HTTP response. Lỗi Prisma và lỗi không phải HttpException vẫn có status code thật. */
const ERROR_LABELS: Record<number, string> = {
  [HttpStatus.BAD_REQUEST]: 'Bad Request',
  [HttpStatus.NOT_FOUND]: 'Not Found',
  [HttpStatus.CONFLICT]: 'Conflict',
};

/**
 * Nửa lỗi của envelope. `code` là phần ổn định của hợp đồng. Chỉ vắng khi body HttpException là chuỗi trần (lỗi framework); khi đó client dùng `statusCode`.
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

  @SentryExceptionCaptured()
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

    // Đây là bug, không phải lỗi của client: log stack và trả về thứ không thể làm lộ message nội bộ.
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

  /** Body của HttpException trong envelope: mảng `message` của ValidationPipe chuyển sang `errors`, các key phụ khác giữ nguyên. */
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

  /** Các mã lỗi Prisma mà app thực sự có thể gây ra; mã không có trong danh sách rơi xuống 500. */
  private translatePrismaError(exception: unknown): {
    statusCode: number;
    code: string;
    message: string;
    error: string;
  } | null {
    if (exception instanceof Prisma.PrismaClientValidationError) {
      // Sai hình dạng dữ liệu đưa vào Prisma - query hỏng được dựng từ input của client.
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

  /** `P2002` mang các cột bị trùng - đáng hiển thị vì nó chỉ đúng tên trường. */
  private fieldsOf(exception: Prisma.PrismaClientKnownRequestError): string {
    const target = (exception.meta as { target?: unknown } | undefined)?.target;
    if (Array.isArray(target)) return `: ${target.join(', ')}`;
    if (typeof target === 'string') return `: ${target}`;
    return '';
  }

  /** Cùng bộ ba key mà response HttpException của Nest dùng. */
  private body(statusCode: number, code: string, message: string) {
    return {
      statusCode,
      code,
      message,
      error: ERROR_LABELS[statusCode] ?? 'Error',
    };
  }
}
