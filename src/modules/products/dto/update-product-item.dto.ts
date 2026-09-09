import { OmitType, PartialType } from '@nestjs/swagger';
import { CreateProductItemDto } from './product-item.dto';

/** Ported from UpdateProductItemRequestDTO: every creatable field except `supplierIds`, which has its own route so an omitting PATCH can't silently detach every supplier. Stock is not here and never was - it moves through sales and stock movements, never an edit. */
export class UpdateProductItemDto extends PartialType(
  OmitType(CreateProductItemDto, ['supplierIds'] as const),
) {}
