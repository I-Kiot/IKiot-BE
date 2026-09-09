import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AppService } from './app.service';
import { Public } from './common/decorators/public.decorator';
import { RawResponse } from './common/decorators/raw-response.decorator';

// Unauthenticated probe endpoint: @Public() skips the global JWT guard, @RawResponse() keeps the bare `{ status: "ok" }` body.
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

  /** Alias of `/` at the path iKiotMS-BE's probe hits, so existing uptime checks keep working. */
  @Public()
  @RawResponse()
  @Get('health')
  health() {
    return this.appService.health();
  }
}
