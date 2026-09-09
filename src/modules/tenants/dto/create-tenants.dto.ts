import { IsOptional, IsString } from 'class-validator';

/** Reachable only through the `AdminOnlyGuard`-gated `/tenants` controller. `bankingSepayWebhookApiKey` is writable here on purpose, replacing the old SUPER_ADMIN-only route, and is never read back. */
export class CreateTenantDto {
  @IsString()
  name: string;

  @IsOptional()
  @IsString()
  tenantOwnerId?: string;

  @IsString()
  status: string;

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
  @IsString()
  bankingAccountNumber?: string;

  @IsOptional()
  @IsString()
  bankingBankName?: string;

  @IsOptional()
  @IsString()
  bankingAccountName?: string;

  /** Platform-admin write only, never returned. See the class comment. */
  @IsOptional()
  @IsString()
  bankingSepayWebhookApiKey?: string;
}
