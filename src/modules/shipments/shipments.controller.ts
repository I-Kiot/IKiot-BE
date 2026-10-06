import {
  Body,
  Controller,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ShipmentService } from './shipments.service';
import { CreateShipmentDto } from './dto/create-shipment.dto';
import { ChangeDriverDto } from './dto/change-driver.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { requireTenantId } from '../../common/utils/tenant-scope';
import type { AuthUser } from '../../common/types/auth-user.type';

/**
 * Lấy hàng & giao hàng (contract §4). Hai route dưới đây **cố ý không có `@Permissions`**: người phụ
 * trách đơn làm được mọi bước của đơn mình mà không cần quyền trong role (chốt 2026-10-06), và guard
 * chạy trước khi biết đơn nào là của ai. Quyền được kiểm trong service bằng `assertOrderStepAccess`:
 * chủ shop, người phụ trách, hoặc người có quyền của bước đó tại kho của fulfillment. Các route đọc
 * (`GET /shipments*`, C-3) và giao hàng (C-5) chưa viết.
 */
@ApiTags('shipments')
@ApiBearerAuth('bearer')
@Controller('shipments')
export class ShipmentController {
  constructor(private readonly service: ShipmentService) {}

  /** C-2 + C-8: "ĐVVC đã lấy hàng" – đơn PACKED → PICKED_UP, gán shipper nếu giao nội bộ. */
  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateShipmentDto) {
    return this.service.create(user, requireTenantId(user), dto);
  }

  /** C-8: đổi shipper / thợ của shipment INTERNAL chưa kết thúc. */
  @Patch(':id/driver')
  changeDriver(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ChangeDriverDto,
  ) {
    return this.service.changeDriver(user, requireTenantId(user), id, dto);
  }
}
