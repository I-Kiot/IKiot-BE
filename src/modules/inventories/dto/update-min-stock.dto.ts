import { Type } from 'class-transformer';
import { IsInt, Min } from 'class-validator';

export class UpdateMinStockDto {
  /** Ngưỡng tồn tối thiểu của dòng này. `0` tắt cảnh báo của món này tại địa điểm này. */
  @Type(() => Number)
  @IsInt({ message: 'minStock phải là số nguyên' })
  @Min(0, { message: 'minStock không được âm' })
  minStock: number;
}
