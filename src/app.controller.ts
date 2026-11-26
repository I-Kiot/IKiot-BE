import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AppService } from './app.service';
import { Public } from './common/decorators/public.decorator';
import { RawResponse } from './common/decorators/raw-response.decorator';

// Probe không cần đăng nhập, trả body thô `{ status: "ok" }`.
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

  /** Readiness cho deploy: 200 khi DB trả lời và đủ migration, ngược lại 503. */
  @Public()
  @RawResponse()
  @Get('health/ready')
  ready() {
    return this.appService.ready();
  }

  /** Ném lỗi có chủ đích để kiểm tra Sentry nhận được lỗi. */
  @Public()
  @Get('debug-sentry')
  getError() {
    throw new Error('My first Sentry error!');
  }
}
