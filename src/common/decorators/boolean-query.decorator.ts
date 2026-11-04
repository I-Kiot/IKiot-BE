import { applyDecorators } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional } from 'class-validator';

/**
 * Cờ boolean tuỳ chọn trên query. Chỉ `'true'` / `'false'` thành boolean; giá trị khác giữ nguyên để `IsBoolean` trả 400, không bao giờ âm thầm thành `false` (`?hasDebt=yes` từng liệt kê mọi NCC).
 */
export function BooleanQuery(message?: string): PropertyDecorator {
  return applyDecorators(
    IsOptional(),
    Transform(({ value }: { value: unknown }) => {
      if (value === 'true') return true;
      if (value === 'false') return false;
      return value;
    }),
    IsBoolean(message ? { message } : undefined),
  );
}
