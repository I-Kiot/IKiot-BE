import { Module } from '@nestjs/common';
import { SalesChannelController } from './sales-channels.controller';
import { SalesChannelService } from './sales-channels.service';

@Module({
  controllers: [SalesChannelController],
  providers: [SalesChannelService],
  exports: [SalesChannelService],
})
export class SalesChannelModule {}
