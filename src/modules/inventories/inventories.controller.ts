import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { InventoryService } from './inventories.service';
import { QueryInventoryDto } from './dto/query-inventory.dto';
import { AddProductToLocationDto } from './dto/add-product-to-location.dto';
import { UpdateMinStockDto } from './dto/update-min-stock.dto';
import { DamagedStockDto } from './dto/damaged-stock.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Permissions } from '../../common/decorators/permissions.decorator';
import { requireTenantId } from '../../common/utils/tenant-scope';
import { EmitsChange } from '../../common/realtime/emits-change.decorator';
import { InventoryChanges } from './inventories.change-template';
import type { AuthUser } from '../../common/types/auth-user.type';

/** Port của InventoryController, vẫn ở `/inventory` số ít. Thêm / xoá hàng tại địa điểm nay dùng `inventory:create` / `delete` (tenant cấp), vì role cũ đã bỏ. */
@ApiTags('inventory')
@ApiBearerAuth('bearer')
@Controller('inventory')
export class InventoryController {
  constructor(private readonly service: InventoryService) {}

  @Permissions('inventory', 'read')
  @Get()
  findAll(@CurrentUser() user: AuthUser, @Query() query: QueryInventoryDto) {
    return this.service.findAll(requireTenantId(user), query);
  }

  @Permissions('inventory', 'update')
  @Patch(':id/min-stock')
  updateMinStock(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateMinStockDto,
  ) {
    return this.service.updateMinStock(requireTenantId(user), id, dto.minStock);
  }

  /** Phát hiện hỏng trên kệ: chuyển `quantity` chiếc sang hàng hỏng tại chính địa điểm (ngoài `stock`). */
  @Permissions('inventory', 'manage_damaged')
  @EmitsChange(InventoryChanges.markedDamaged)
  @Post(':id/mark-damaged')
  markDamaged(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DamagedStockDto,
  ) {
    return this.service.changeDamaged(user, id, 'mark', dto);
  }

  /** Hàng hỏng sửa xong: về lại bán được, giữ giá vốn và ngày nhập. */
  @Permissions('inventory', 'manage_damaged')
  @EmitsChange(InventoryChanges.repaired)
  @Post(':id/repair-damaged')
  repairDamaged(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DamagedStockDto,
  ) {
    return this.service.changeDamaged(user, id, 'repair', dto);
  }

  /** Huỷ / thanh lý hàng hỏng: hàng rời khỏi sổ kho. */
  @Permissions('inventory', 'manage_damaged')
  @EmitsChange(InventoryChanges.writtenOff)
  @Post(':id/write-off-damaged')
  writeOffDamaged(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DamagedStockDto,
  ) {
    return this.service.changeDamaged(user, id, 'writeOff', dto);
  }

  @Permissions('inventory', 'create')
  @Post()
  addProductToLocation(
    @CurrentUser() user: AuthUser,
    @Body() dto: AddProductToLocationDto,
  ) {
    return this.service.addProductToLocation(requireTenantId(user), dto);
  }

  @Permissions('inventory', 'delete')
  @Delete(':id')
  removeProductFromLocation(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.removeProductFromLocation(requireTenantId(user), id);
  }
}
