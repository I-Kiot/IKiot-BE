import { IsUUID } from 'class-validator';

export class AddSupplierToItemDto {
  @IsUUID()
  supplierId: string;
}
