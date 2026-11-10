import { registerDecorator, type ValidationOptions } from 'class-validator';
import { isContactPhone } from '../utils/contact-phone';

interface ContactPhoneOptions extends ValidationOptions {
  /** Cho phép chuỗi rỗng, để PATCH xoá được số đã lưu. */
  allowEmpty?: boolean;
}

/** SĐT liên hệ hợp lệ (xem `isContactPhone`). Dùng `each: true` cho mảng số điện thoại. */
export function IsContactPhone(options: ContactPhoneOptions = {}) {
  const { allowEmpty, ...validationOptions } = options;
  return (target: object, propertyName: string) => {
    registerDecorator({
      name: 'isContactPhone',
      target: target.constructor,
      propertyName,
      options: {
        message: 'Số điện thoại không hợp lệ',
        ...validationOptions,
      },
      validator: {
        validate: (value: unknown) =>
          (allowEmpty === true && typeof value === 'string' && !value.trim()) ||
          isContactPhone(value),
      },
    });
  };
}
