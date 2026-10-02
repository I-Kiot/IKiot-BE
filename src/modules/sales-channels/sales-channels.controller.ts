import { Controller } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { SalesChannelService } from './sales-channels.service';

/** Connected marketplace shops (Shopee) and their SKU mappings (docs/order-flow.md B1a, Phase 2). Shell created in Phase 0 (P0-4); the routes are track A / E (Astersa)'s, written against docs/api-contract-order-flow.md. Every route needs its own @Permissions. */
@ApiTags('sales-channels')
@ApiBearerAuth('bearer')
@Controller('sales-channels')
export class SalesChannelController {
  constructor(private readonly service: SalesChannelService) {}
}
