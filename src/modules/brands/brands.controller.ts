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
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { BrandService } from './brands.service';
import { CreateBrandDto } from './dto/create-brand.dto';
import { UpdateBrandDto } from './dto/update-brand.dto';
import { QueryBrandDto } from './dto/query-brand.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Permissions } from '../../common/decorators/permissions.decorator';
import { requireTenantId } from '../../common/utils/tenant-scope';
import type { AuthUser } from '../../common/types/auth-user.type';

// Ported from iKiotMS-BE's brand module, where every route ran on bare verifyJwt - any logged-in user could edit any brand in the system.
@ApiTags('brands')
@ApiBearerAuth('bearer')
@Controller('brands')
export class BrandController {
  constructor(private readonly service: BrandService) {}

  @Permissions('brands', 'read')
  @Get()
  @ApiOperation({ summary: 'Danh sách thương hiệu' })
  findAll(@CurrentUser() user: AuthUser, @Query() query: QueryBrandDto) {
    return this.service.findAll(requireTenantId(user), query);
  }

  @Permissions('brands', 'read')
  @Get(':id')
  @ApiOperation({ summary: 'Chi tiết thương hiệu' })
  findOne(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.findOne(requireTenantId(user), id);
  }

  @Permissions('brands', 'create')
  @Post()
  @ApiOperation({ summary: 'Tạo thương hiệu' })
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateBrandDto) {
    return this.service.create(requireTenantId(user), dto);
  }

  @Permissions('brands', 'update')
  @Patch(':id')
  @ApiOperation({ summary: 'Cập nhật thương hiệu' })
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateBrandDto,
  ) {
    return this.service.update(requireTenantId(user), id, dto);
  }

  @Permissions('brands', 'delete')
  @Delete(':id')
  @ApiOperation({
    summary: 'Xoá thương hiệu',
    description: 'Chỉ xoá được khi không còn sản phẩm nào sử dụng.',
  })
  remove(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.remove(requireTenantId(user), id);
  }
}
