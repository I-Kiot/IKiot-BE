import { applyDecorators } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsEmail } from 'class-validator';

/** Email đồng thời là khoá tra cứu: được validate, chuyển chữ thường và trim trong plainToInstance, nên mọi đường ghi lưu cùng một dạng chuẩn. */
export function NormalizeEmail(): PropertyDecorator {
  return applyDecorators(
    Transform(({ value }: { value: unknown }) =>
      typeof value === 'string' ? value.toLowerCase().trim() : value,
    ),
    IsEmail({}, { message: 'Email không hợp lệ' }),
  );
}
