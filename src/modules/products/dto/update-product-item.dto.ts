import { OmitType, PartialType } from '@nestjs/swagger';
import { CreateProductItemDto } from './product-item.dto';

/** Port từ UpdateProductItemRequestDTO. Không có `supplierIds` (route riêng, PATCH thiếu trường không gỡ hết NCC) và `itemType` (cố định lúc tạo). Tồn kho chỉ đổi qua bán hàng và phiếu kho. */
export class UpdateProductItemDto extends PartialType(
  OmitType(CreateProductItemDto, ['supplierIds', 'itemType'] as const),
) {}
