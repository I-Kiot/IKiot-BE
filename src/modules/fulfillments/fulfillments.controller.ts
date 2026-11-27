import { Controller } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

/** Controller đóng gói (trống, đóng gói qua `POST /orders/:id/pack`). */
@ApiTags('fulfillments')
@ApiBearerAuth('bearer')
@Controller('fulfillments')
export class FulfillmentController {}
