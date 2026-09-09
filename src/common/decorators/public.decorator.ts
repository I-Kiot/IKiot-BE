import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/** Marks a route as not requiring JwtAuthGuard - for login/register/etc. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
