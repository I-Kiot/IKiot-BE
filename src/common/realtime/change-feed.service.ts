import { Injectable, Logger } from '@nestjs/common';
import { publishChange } from './change-feed';
import type { PublishChangeInput } from './change-feed.types';
import { RealtimeGateway } from './realtime.gateway';

/** Cửa vào DI của feed thay đổi cho interceptor, cron và webhook controller. Service đã có `RealtimeGateway` thì gọi thẳng `publishChange`. */
@Injectable()
export class ChangeFeedService {
  private readonly logger = new Logger(ChangeFeedService.name);

  constructor(private readonly gateway: RealtimeGateway) {}

  publish(input: PublishChangeInput): void {
    publishChange(this.gateway, input, this.logger);
  }
}
