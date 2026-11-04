import { Controller } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { SalesChannelService } from './sales-channels.service';

/** Shop marketplace đã kết nối (Shopee) và mapping SKU (docs/order-flow.md B1a, Phase 2). Khung ở Phase 0 (P0-4); route thuộc track A / E (docs/api-contract-order-flow.md). Mỗi route cần `@Permissions` riêng. */
@ApiTags('sales-channels')
@ApiBearerAuth('bearer')
@Controller('sales-channels')
export class SalesChannelController {
  constructor(private readonly service: SalesChannelService) {}
}
