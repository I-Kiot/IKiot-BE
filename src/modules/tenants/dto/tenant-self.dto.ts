import { Type } from 'class-transformer';
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';

/** Tài khoản nhận tiền SePay của shop. Phải đủ cả ba trường hoặc không có. */
export class BankingDto {
  @IsString()
  @IsNotEmpty({ message: 'Số tài khoản không được để trống' })
  accountNumber: string;

  @IsString()
  @IsNotEmpty({ message: 'Tên ngân hàng không được để trống' })
  bankName: string;

  @IsString()
  @IsNotEmpty({ message: 'Tên chủ tài khoản không được để trống' })
  accountName: string;
}

/** `PUT /tenant/me`: shop tự sửa hồ sơ. Cố ý không có `status`: bản cũ truyền thẳng body, nên shop đang SUSPENDED có thể tự chuyển về ACTIVE. */
export class UpdateMyTenantDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: 'Tên cửa hàng không được để trống' })
  name?: string;

  @IsOptional()
  @IsString()
  phoneNumber?: string;

  @IsOptional()
  @IsString()
  mainAddress?: string;

  @IsOptional()
  @IsString()
  taxNumber?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => BankingDto)
  banking?: BankingDto;
}

export class SetSepayKeyDto {
  @IsString()
  @IsNotEmpty({ message: 'sepayWebhookApiKey không được để trống' })
  sepayWebhookApiKey: string;
}
