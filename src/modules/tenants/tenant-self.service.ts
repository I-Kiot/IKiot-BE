import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationService } from '../notifications/notifications.service';
import { TenantNotificationTemplates } from '../notifications/templates/tenant.templates';
import { TENANT_SELECT, withNestedBanking } from './tenant-select';
import { BankingDto, UpdateMyTenantDto } from './dto/tenant-self.dto';
import { ErrorCode } from '../../common/errors/error-codes';

interface BankingSnapshot {
  bankingAccountNumber: string | null;
  bankingBankName: string | null;
  bankingAccountName: string | null;
}

/** Did the account actually change? Ported from the old `bankingChanged` helper. */
function bankingChanged(before: BankingSnapshot, after: BankingSnapshot) {
  return (
    before.bankingAccountNumber !== after.bankingAccountNumber ||
    before.bankingBankName !== after.bankingBankName ||
    before.bankingAccountName !== after.bankingAccountName
  );
}

/** Enough of an account to be worth linking. Ported from `hasBankInfo`. */
function hasBankInfo(banking: BankingSnapshot) {
  return Boolean(banking.bankingAccountNumber && banking.bankingBankName);
}

/** A shop reading and editing its own record, kept separate from the platform-admin `TenantService` because it never takes a tenant id from the caller. This is what makes SePay order payments usable at all - until these routes were ported the banking fields could only be set by writing to the database by hand - and the two notifications here are the manual linking workflow. */
@Injectable()
export class TenantSelfService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationService,
  ) {}

  /** The shop's own record, with `hasSepayKey` instead of the key itself: the settings screen needs to show whether the account is linked, and nothing needs the secret back. */
  async findMine(tenantId: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { ...TENANT_SELECT, bankingSepayWebhookApiKey: true },
    });
    if (!tenant)
      throw new NotFoundException({
        code: ErrorCode.TENANT_NOT_FOUND,
        message: 'Shop not found',
      });

    const { bankingSepayWebhookApiKey, ...rest } = tenant;
    return {
      ...withNestedBanking(rest),
      hasSepayKey: Boolean(bankingSepayWebhookApiKey),
    };
  }

  /** `PUT /tenant/me`. Sends the operators a heads-up when the bank account changes. */
  async updateMine(tenantId: string, dto: UpdateMyTenantDto) {
    const before = await this.bankingOf(tenantId);

    const tenant = await this.prisma.tenant.update({
      where: { id: tenantId },
      data: {
        name: dto.name,
        phoneNumber: dto.phoneNumber,
        mainAddress: dto.mainAddress,
        taxNumber: dto.taxNumber,
        ...(dto.banking
          ? {
              bankingAccountNumber: dto.banking.accountNumber,
              bankingBankName: dto.banking.bankName,
              bankingAccountName: dto.banking.accountName,
            }
          : {}),
      },
      select: TENANT_SELECT,
    });

    if (dto.banking) await this.announceBankChange(before, tenant);
    return withNestedBanking(tenant);
  }

  /** `PUT /tenant/banking` - the same write on its own route, as the old API had it. */
  async updateBanking(tenantId: string, dto: BankingDto) {
    const before = await this.bankingOf(tenantId);

    const tenant = await this.prisma.tenant.update({
      where: { id: tenantId },
      data: {
        bankingAccountNumber: dto.accountNumber,
        bankingBankName: dto.bankName,
        bankingAccountName: dto.accountName,
      },
      select: TENANT_SELECT,
    });

    await this.announceBankChange(before, tenant);
    return withNestedBanking(tenant);
  }

  /** Records the SePay webhook key an operator has provisioned for a shop and tells the owners they can take QR payments. Platform-admin only: iKiotMS-BE's comment said SUPER_ADMIN but nothing checked it, so any account with `tenants:update` could write any shop's key - and that key is what identifies a tenant to the payment webhook. */
  async setSepayKey(tenantId: string, sepayWebhookApiKey: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true },
    });
    if (!tenant)
      throw new NotFoundException({
        code: ErrorCode.TENANT_NOT_FOUND,
        message: 'Shop not found',
      });

    await this.prisma.tenant.update({
      where: { id: tenantId },
      data: { bankingSepayWebhookApiKey: sepayWebhookApiKey },
    });

    const owners = await this.notifications.tenantOwners(tenantId);
    await this.notifications.notify({
      tenantId,
      recipientIds: owners,
      referenceId: tenantId,
      ...TenantNotificationTemplates.sepayLinked(),
    });

    return { message: 'SePay key saved' };
  }

  private async bankingOf(tenantId: string): Promise<BankingSnapshot> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: {
        bankingAccountNumber: true,
        bankingBankName: true,
        bankingAccountName: true,
      },
    });
    if (!tenant)
      throw new NotFoundException({
        code: ErrorCode.TENANT_NOT_FOUND,
        message: 'Shop not found',
      });
    return tenant;
  }

  /** Only when the details really moved, and only once they are worth linking. */
  private async announceBankChange(
    before: BankingSnapshot,
    after: BankingSnapshot & { name: string },
  ) {
    if (!bankingChanged(before, after) || !hasBankInfo(after)) return;
    await this.notifications.notifySystem(
      TenantNotificationTemplates.bankAccountUpdated(
        after.name,
        after.bankingBankName,
        after.bankingAccountNumber,
      ),
    );
  }
}
