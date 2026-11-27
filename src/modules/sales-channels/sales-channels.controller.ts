import { Controller } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { SalesChannelService } from './sales-channels.service';

/** Controller kênh bán (Shopee), chưa có route. */
@ApiTags('sales-channels')
@ApiBearerAuth('bearer')
@Controller('sales-channels')
export class SalesChannelController {
  constructor(private readonly service: SalesChannelService) {}
}
