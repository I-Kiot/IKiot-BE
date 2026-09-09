import { Type } from 'class-transformer';
import { IsInt, Min } from 'class-validator';

/** Ported from iKiotMS-BE's UpdateMinStockDTO. */
export class UpdateMinStockDto {
  /** The low-stock threshold for this line. `0` switches the alert off for this item here. */
  @Type(() => Number)
  @IsInt({ message: 'minStock phải là số nguyên' })
  @Min(0, { message: 'minStock không được âm' })
  minStock: number;
}
