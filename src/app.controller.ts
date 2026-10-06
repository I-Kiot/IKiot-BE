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

  /**
   * Readiness, for deploys: 200 only when the database answers and has every migration this image
   * ships, 503 otherwise. Kept off `/health` on purpose - the container healthcheck polls that one,
   * and a database blip must not get the API restarted.
   */
  @Public()
  @RawResponse()
  @Get('health/ready')
  ready() {
    return this.appService.ready();
  }

  /** Sentry's own smoke test: throws on purpose so the `@SentryExceptionCaptured()` path in `AllExceptionsFilter` can be verified end-to-end. Public so it's reachable with a bare curl. */
  @Public()
  @Get('debug-sentry')
  getError() {
    throw new Error('My first Sentry error!');
  }
}
