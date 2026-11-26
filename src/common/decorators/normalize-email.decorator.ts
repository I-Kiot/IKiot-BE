import { applyDecorators } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsEmail } from 'class-validator';

/** Chuẩn hoá email: kiểm tra, chữ thường, bỏ khoảng trắng. */
export function NormalizeEmail(): PropertyDecorator {
  return applyDecorators(
    Transform(({ value }: { value: unknown }) =>
      typeof value === 'string' ? value.toLowerCase().trim() : value,
    ),
    IsEmail({}, { message: 'Email không hợp lệ' }),
  );
}
