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
import { ProductService } from './products.service';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import {
  CreateProductItemDto,
  ProductAttributeDto,
} from './dto/product-item.dto';
import { UpdateProductItemDto } from './dto/update-product-item.dto';
import { AddSupplierToItemDto } from './dto/add-supplier.dto';
import {
  QueryProductDto,
  QueryProductItemDto,
  SearchProductDto,
} from './dto/query-product.dto';
import { LocationRefQueryDto } from '../../common/dto/location-ref.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Permissions } from '../../common/decorators/permissions.decorator';
import { requireTenantId } from '../../common/utils/tenant-scope';
import type { AuthUser } from '../../common/types/auth-user.type';

/** Port của ProductController. Mọi route có permission riêng: module cũ chỉ kiểm JWT nên mọi tài khoản (cả CUSTOMER) đều sửa được danh mục. Hai đường bỏ hậu tố `/delete`. */
@ApiTags('products')
@ApiBearerAuth('bearer')
@Controller('products')
export class ProductController {
  constructor(private readonly service: ProductService) {}

  @Permissions('products', 'create')
  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateProductDto) {
    return this.service.create(requireTenantId(user), dto);
  }

  @Permissions('products', 'read')
  @Get()
  findAll(@CurrentUser() user: AuthUser, @Query() query: QueryProductDto) {
    return this.service.findAll(requireTenantId(user), query);
  }

  // `items` và `search` phải nằm trên `:id`, nếu không router coi chúng là product id và mọi lần gọi 404.
  @Permissions('products', 'read')
  @Get('items')
  listItems(
    @CurrentUser() user: AuthUser,
    @Query() query: QueryProductItemDto,
  ) {
    return this.service.listItems(requireTenantId(user), query);
  }

  @Permissions('products', 'read')
  @Get('search')
  search(@CurrentUser() user: AuthUser, @Query() query: SearchProductDto) {
    return this.service.search(requireTenantId(user), query);
  }

  @Permissions('products', 'read')
  @Get(':id')
  findOne(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() location: LocationRefQueryDto,
  ) {
    return this.service.findOne(requireTenantId(user), id, location);
  }

  @Permissions('products', 'update')
  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateProductDto,
  ) {
    return this.service.update(requireTenantId(user), id, dto);
  }

  /** Thêm thuộc tính cho sản phẩm (nút "Thêm thuộc tính" ở màn đơn và YCSX). Trùng tên thì trả thuộc tính có sẵn. */
  @Permissions('products', 'update')
  @Post(':id/attributes')
  addAttribute(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ProductAttributeDto,
  ) {
    return this.service.addAttribute(requireTenantId(user), id, dto);
  }

  @Permissions('products', 'delete')
  @Delete(':id')
  discontinue(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.discontinue(requireTenantId(user), id);
  }

  // Route ba đoạn nên không đụng `/products/:id`; chỉ `GET items` và `GET search` cần đặt trên.
  @Permissions('products', 'update')
  @Patch('items/:itemId')
  updateItem(
    @CurrentUser() user: AuthUser,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body() dto: UpdateProductItemDto,
  ) {
    return this.service.updateItem(requireTenantId(user), itemId, dto);
  }

  @Permissions('products', 'delete')
  @Delete('items/:itemId')
  removeItem(
    @CurrentUser() user: AuthUser,
    @Param('itemId', ParseUUIDPipe) itemId: string,
  ) {
    return this.service.removeItem(requireTenantId(user), itemId);
  }

  @Permissions('products', 'update')
  @Post('items/:itemId/suppliers')
  addSupplierToItem(
    @CurrentUser() user: AuthUser,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body() dto: AddSupplierToItemDto,
  ) {
    return this.service.addSupplierToItem(
      requireTenantId(user),
      itemId,
      dto.supplierId,
    );
  }

  @Permissions('products', 'create')
  @Post(':productId/items')
  createItem(
    @CurrentUser() user: AuthUser,
    @Param('productId', ParseUUIDPipe) productId: string,
    @Body() dto: CreateProductItemDto,
  ) {
    return this.service.createItem(requireTenantId(user), productId, dto);
  }
}
