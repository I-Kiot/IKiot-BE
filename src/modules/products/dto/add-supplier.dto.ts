import { IsUUID } from 'class-validator';

/** Ported from iKiotMS-BE's AddSupplierToItemRequestDTO. */
export class AddSupplierToItemDto {
  @IsUUID()
  supplierId: string;
}
