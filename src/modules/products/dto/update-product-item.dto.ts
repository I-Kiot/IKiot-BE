import { OmitType, PartialType } from '@nestjs/swagger';
import { CreateProductItemDto } from './product-item.dto';

/** Body sửa phiên bản; NCC và loại sửa ở chỗ khác. */
export class UpdateProductItemDto extends PartialType(
  OmitType(CreateProductItemDto, ['supplierIds', 'itemType'] as const),
) {}
