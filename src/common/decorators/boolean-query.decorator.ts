import { applyDecorators } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional } from 'class-validator';

/**
 * An optional boolean query flag (`?onlyShort=true`). A query string only ever carries text, so
 * `'true'` / `'false'` become booleans and anything else is passed through for `IsBoolean` to refuse
 * with a 400 - never silently read as `false`, which is what several hand-written copies of this did
 * (`?hasDebt=yes` listed every supplier). Absent stays `undefined`.
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
