import { applyDecorators } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional } from 'class-validator';

/** Cờ boolean trên query: chỉ nhận 'true'/'false', giá trị khác trả 400. */
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
