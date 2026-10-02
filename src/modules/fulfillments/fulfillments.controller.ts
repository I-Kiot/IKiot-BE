import { Controller } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { FulfillmentService } from './fulfillments.service';

/** Packing a READY_TO_PACK order. Verifying the packed goods is what deducts the stock, through InventoryService.consume (docs/order-flow.md B5). Shell created in Phase 0 (P0-4); the routes are track C (kieudang)'s, written against docs/api-contract-order-flow.md. Every route needs its own @Permissions. */
@ApiTags('fulfillments')
@ApiBearerAuth('bearer')
@Controller('fulfillments')
export class FulfillmentController {
  constructor(private readonly service: FulfillmentService) {}
}
