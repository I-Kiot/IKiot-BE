import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PromotionService } from './promotions.service';
import {
  CreatePromotionDto,
  PriceCartDto,
  QueryPromotionDto,
  UpdatePromotionDto,
} from './dto/promotion.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Permissions } from '../../common/decorators/permissions.decorator';
import { requireTenantId } from '../../common/utils/tenant-scope';
import type { AuthUser } from '../../common/types/auth-user.type';

/** Port từ PromotionController - cùng chín route và permission. `/candidates`, `/calculate`, `/apply` dùng POST vì mang theo giỏ hàng; chỉ `/apply` ghi dữ liệu. */
@ApiTags('promotions')
@ApiBearerAuth('bearer')
@Controller('promotions')
export class PromotionController {
  constructor(private readonly service: PromotionService) {}

  @Permissions('promotions', 'create')
  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreatePromotionDto) {
    return this.service.create(requireTenantId(user), dto);
  }

  @Permissions('promotions', 'read')
  @Get()
  findAll(@CurrentUser() user: AuthUser, @Query() query: QueryPromotionDto) {
    return this.service.findAll(user, requireTenantId(user), query);
  }

  // Ba route giỏ hàng khai báo trên `:id`: là POST nên không thể thực sự trùng với `:id`, nhưng gom lại cho dễ đọc.

  /** Liệt kê mọi ứng viên cho giỏ này, đủ hoặc không đủ điều kiện, kèm lý do. */
  @Permissions('promotions', 'calculate')
  @HttpCode(HttpStatus.OK)
  @Post('candidates')
  candidates(@CurrentUser() user: AuthUser, @Body() dto: PriceCartDto) {
    return this.service.listCandidates(requireTenantId(user), dto);
  }

  /** Chỉ xem trước, không ghi gì. */
  @Permissions('promotions', 'calculate')
  @HttpCode(HttpStatus.OK)
  @Post('calculate')
  calculate(@CurrentUser() user: AuthUser, @Body() dto: PriceCartDto) {
    return this.service.calculate(requireTenantId(user), dto);
  }

  /** Ghi nhận mức giảm vào đơn: số lần dùng tăng và log được ghi. */
  @Permissions('promotions', 'apply')
  @HttpCode(HttpStatus.OK)
  @Post('apply')
  apply(@CurrentUser() user: AuthUser, @Body() dto: PriceCartDto) {
    return this.service.apply(requireTenantId(user), user.userId, dto);
  }

  @Permissions('promotions', 'read')
  @Get(':id')
  findOne(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.findOne(user, requireTenantId(user), id);
  }

  @Permissions('promotions', 'read')
  @Get(':id/logs')
  findLogs(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: QueryPromotionDto,
  ) {
    return this.service.findLogs(user, requireTenantId(user), id, query);
  }

  @Permissions('promotions', 'update')
  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePromotionDto,
  ) {
    return this.service.update(user, requireTenantId(user), id, dto);
  }

  /** Xoá mềm: chuyển status sang INACTIVE. Xem PromotionService.deactivate. */
  @Permissions('promotions', 'delete')
  @Delete(':id')
  deactivate(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.deactivate(user, requireTenantId(user), id);
  }
}
