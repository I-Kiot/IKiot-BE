import { Controller } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ProductionRequestService } from './production-requests.service';

/** "Yêu cầu sản xuất" sent to a WORKSHOP supplier and tracked by hand; the goods come back through a WORKSHOP import (docs/order-flow.md B4). Shell created in Phase 0 (P0-4); the routes are track B (ndpp)'s, written against docs/api-contract-order-flow.md. Every route needs its own @Permissions. */
@ApiTags('production-requests')
@ApiBearerAuth('bearer')
@Controller('production-requests')
export class ProductionRequestController {
  constructor(private readonly service: ProductionRequestService) {}
}
