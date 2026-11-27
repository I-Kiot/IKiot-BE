import { Type } from 'class-transformer';
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  ValidateIf,
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

/** Ba ô ngân hàng, điền thì phải đủ. */
export class OptionalBankingDto {
  @IsOptional()
  @IsString()
  accountNumber?: string | null;

  @IsOptional()
  @IsString()
  bankName?: string | null;

  @IsOptional()
  @IsString()
  accountName?: string | null;
}

/** Body shop tự sửa hồ sơ. */
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

  /** URL ảnh `POST /uploads` trả về. Chuỗi rỗng hoặc `null` là gỡ logo; bỏ trường thì giữ nguyên. */
  @ValidateIf((_, value) => value !== null && value !== '')
  @IsOptional()
  @IsUrl(
    { protocols: ['http', 'https'], require_protocol: true },
    { message: 'Logo phải là đường dẫn ảnh hợp lệ' },
  )
  @MaxLength(2048, { message: 'Đường dẫn logo quá dài' })
  logoUrl?: string | null;

  @IsOptional()
  @ValidateNested()
  @Type(() => OptionalBankingDto)
  banking?: OptionalBankingDto;
}

export class SetSepayKeyDto {
  @IsString()
  @IsNotEmpty({ message: 'sepayWebhookApiKey không được để trống' })
  sepayWebhookApiKey: string;
}
