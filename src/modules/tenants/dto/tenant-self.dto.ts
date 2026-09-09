import { Type } from 'class-transformer';
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';

/** The bank account a shop receives SePay payments into. All three or none. */
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

/** `PUT /tenant/me` - the shop editing its own record. `status` is deliberately absent: iKiotMS-BE passed the body straight through, so a SUSPENDED shop could set itself back to ACTIVE. */
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

/** `PUT /tenant/:tenantId/sepay-key` - platform-admin only. */
export class SetSepayKeyDto {
  @IsString()
  @IsNotEmpty({ message: 'sepayWebhookApiKey không được để trống' })
  sepayWebhookApiKey: string;
}
