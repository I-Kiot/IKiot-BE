import { applyDecorators } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsEmail } from 'class-validator';

/** Email that is also a lookup key: validated, lowercased and trimmed during plainToInstance, so every write path stores the same canonical form. */
export function NormalizeEmail(): PropertyDecorator {
  return applyDecorators(
    Transform(({ value }: { value: unknown }) =>
      typeof value === 'string' ? value.toLowerCase().trim() : value,
    ),
    IsEmail({}, { message: 'Email không hợp lệ' }),
  );
}
