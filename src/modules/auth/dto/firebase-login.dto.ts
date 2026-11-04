import { IsIn, IsOptional, IsString } from 'class-validator';

export class FirebaseLoginDto {
  @IsString()
  idToken: string;

  /** "mobile" chỉ cho tài khoản STAFF; mặc định là dashboard web, cho mọi loại trừ CUSTOMER. */
  @IsOptional()
  @IsIn(['mobile', 'web'])
  platform?: 'mobile' | 'web';
}
