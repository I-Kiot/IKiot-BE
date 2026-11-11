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
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import { ProductService } from './products.service';
import {
  ProductImportService,
  XLSX_MIME,
} from './import/product-import.service';
import { MAX_IMPORT_BYTES } from './import/product-import.columns';
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
import { QueryPriceHistoryDto } from './dto/query-price-history.dto';
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
  constructor(
    private readonly service: ProductService,
    private readonly importer: ProductImportService,
  ) {}

  @Permissions('products', 'create')
  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateProductDto) {
    return this.service.create(requireTenantId(user), dto, user.userId);
  }

  @Permissions('products', 'read')
  @Get()
  findAll(@CurrentUser() user: AuthUser, @Query() query: QueryProductDto) {
    return this.service.findAll(requireTenantId(user), query);
  }

  /** File Excel mẫu để nhập hàng hoá - dropdown danh mục/thương hiệu/NCC lấy từ chính cửa hàng, nên gated như việc tạo. */
  @Permissions('products', 'create')
  @Get('import/template')
  @ApiProduces(XLSX_MIME)
  async importTemplate(@CurrentUser() user: AuthUser) {
    const buffer = await this.importer.buildTemplate(requireTenantId(user));
    return new StreamableFile(buffer, {
      type: XLSX_MIME,
      disposition: 'attachment; filename="mau-nhap-hang-hoa.xlsx"',
    });
  }

  /** Nhập hàng hoá + mặt hàng từ file mẫu. Cả file hợp lệ mới tạo; sai thì 400 kèm `errors: [{ row, column, message }]`. */
  @Permissions('products', 'create')
  @Post('import')
  @HttpCode(HttpStatus.CREATED)
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  // Multer chặn file quá lớn ngay khi đọc socket; service kiểm lại để trả lỗi có `code`.
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MAX_IMPORT_BYTES + 1 } }),
  )
  importProducts(
    @CurrentUser() user: AuthUser,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    return this.importer.import(requireTenantId(user), file, user.userId);
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
  @Permissions('products', 'read')
  @Get('items/:itemId/price-history')
  priceHistory(
    @CurrentUser() user: AuthUser,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Query() query: QueryPriceHistoryDto,
  ) {
    return this.service.priceHistory(requireTenantId(user), itemId, query);
  }

  @Permissions('products', 'update')
  @Patch('items/:itemId')
  updateItem(
    @CurrentUser() user: AuthUser,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body() dto: UpdateProductItemDto,
  ) {
    return this.service.updateItem(
      requireTenantId(user),
      itemId,
      dto,
      user.userId,
    );
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
    return this.service.createItem(
      requireTenantId(user),
      productId,
      dto,
      user.userId,
    );
  }
}
