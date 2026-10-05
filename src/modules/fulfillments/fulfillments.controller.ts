import { Controller } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

/** Khung trống: contract §7 bỏ các route /fulfillments/*. Đóng gói đi qua POST /orders/:id/pack (OrderController → FulfillmentService.packOrder). Route mới thêm vào đây phải có @Permissions riêng. */
@ApiTags('fulfillments')
@ApiBearerAuth('bearer')
@Controller('fulfillments')
export class FulfillmentController {}
