import { Controller } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ShipmentService } from './shipments.service';

/** Delivery attempts - carrier (EXTERNAL) or our own shipper with proof photos (INTERNAL) (docs/order-flow.md B6). Shell created in Phase 0 (P0-4); the routes are track C (kieudang)'s, written against docs/api-contract-order-flow.md. Every route needs its own @Permissions. */
@ApiTags('shipments')
@ApiBearerAuth('bearer')
@Controller('shipments')
export class ShipmentController {
  constructor(private readonly service: ShipmentService) {}
}
