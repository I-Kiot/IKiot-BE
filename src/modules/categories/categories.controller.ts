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
import { CategoryService } from './categories.service';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';
import { QueryCategoryDto } from './dto/query-category.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Permissions } from '../../common/decorators/permissions.decorator';
import { requireTenantId } from '../../common/utils/tenant-scope';
import type { AuthUser } from '../../common/types/auth-user.type';

// Port từ module category của iKiotMS-BE (như brands, module này chạy không có authorize()).
@ApiTags('categories')
@ApiBearerAuth('bearer')
@Controller('categories')
export class CategoryController {
  constructor(private readonly service: CategoryService) {}

  @Permissions('categories', 'read')
  @Get()
  @ApiOperation({
    summary: 'Danh sách danh mục',
    description: 'Truyền `parentId=null` để chỉ lấy danh mục cấp gốc.',
  })
  findAll(@CurrentUser() user: AuthUser, @Query() query: QueryCategoryDto) {
    return this.service.findAll(requireTenantId(user), query);
  }

  // Phải nằm trên @Get(':id'): route khớp từ trên xuống, nếu không 'tree' sẽ bị coi là :id và ParseUUIDPipe trả 400 khó hiểu.
  @Permissions('categories', 'read')
  @Get('tree')
  @ApiOperation({ summary: 'Cây danh mục (toàn bộ, lồng nhau)' })
  findTree(@CurrentUser() user: AuthUser) {
    return this.service.findTree(requireTenantId(user));
  }

  @Permissions('categories', 'read')
  @Get(':id')
  @ApiOperation({
    summary: 'Chi tiết danh mục',
    description: 'Kèm `breadcrumbs` - chuỗi danh mục cha từ gốc xuống.',
  })
  findOne(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.findOne(requireTenantId(user), id);
  }

  @Permissions('categories', 'create')
  @Post()
  @ApiOperation({ summary: 'Tạo danh mục' })
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateCategoryDto) {
    return this.service.create(requireTenantId(user), dto);
  }

  @Permissions('categories', 'update')
  @Patch(':id')
  @ApiOperation({
    summary: 'Cập nhật danh mục',
    description: 'Từ chối nếu danh mục cha mới tạo thành vòng lặp.',
  })
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCategoryDto,
  ) {
    return this.service.update(requireTenantId(user), id, dto);
  }

  @Permissions('categories', 'delete')
  @Delete(':id')
  @ApiOperation({
    summary: 'Xoá danh mục',
    description:
      'Chỉ xoá được khi không còn danh mục con và không còn sản phẩm.',
  })
  remove(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.remove(requireTenantId(user), id);
  }
}
