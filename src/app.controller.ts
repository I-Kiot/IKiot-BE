import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AppService } from './app.service';
import { Public } from './common/decorators/public.decorator';
import { RawResponse } from './common/decorators/raw-response.decorator';

// Endpoint probe không cần xác thực: @Public() bỏ qua JWT guard toàn cục, @RawResponse() giữ body `{ status: "ok" }` thô.
@ApiTags('health')
@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Public()
  @RawResponse()
  @Get()
  root() {
    return this.appService.health();
  }

  /** Bí danh của `/` ở đường dẫn mà probe của iKiotMS-BE đang gọi, để các uptime check cũ vẫn chạy. */
  @Public()
  @RawResponse()
  @Get('health')
  health() {
    return this.appService.health();
  }

  /**
   * Readiness cho deploy: 200 khi DB trả lời và đủ migration của image, ngược lại 503.
   * Không gộp vào `/health`: container healthcheck gọi route đó, DB chớp tắt không được restart API.
   */
  @Public()
  @RawResponse()
  @Get('health/ready')
  ready() {
    return this.appService.ready();
  }

  /** Smoke test của Sentry: ném lỗi có chủ đích để kiểm chứng đường `@SentryExceptionCaptured()` trong `AllExceptionsFilter`. Public để gọi bằng curl. */
  @Public()
  @Get('debug-sentry')
  getError() {
    throw new Error('My first Sentry error!');
  }
}
