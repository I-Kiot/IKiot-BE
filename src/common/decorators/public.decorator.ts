import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/** Route không cần JwtAuthGuard - dùng cho đăng nhập, đăng ký... */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
