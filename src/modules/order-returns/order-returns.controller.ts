import { Controller } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { OrderReturnService } from './order-returns.service';

/** "Đơn hoàn hàng", opened by hand for any channel; GOOD lines go back to a sellable location, DAMAGED ones to its damaged-goods location (docs/order-flow.md B7). Shell created in Phase 0 (P0-4); the routes are track D (ducna)'s, written against docs/api-contract-order-flow.md. Every route needs its own @Permissions. */
@ApiTags('order-returns')
@ApiBearerAuth('bearer')
@Controller('order-returns')
export class OrderReturnController {
  constructor(private readonly service: OrderReturnService) {}
}
