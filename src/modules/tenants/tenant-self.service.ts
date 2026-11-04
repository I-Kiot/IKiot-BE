import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationService } from '../notifications/notifications.service';
import { TenantNotificationTemplates } from '../notifications/templates/tenant.templates';
import {
  TENANT_SELECT,
  isSepayLinked,
  withNestedBanking,
} from './tenant-select';
import { BankingDto, UpdateMyTenantDto } from './dto/tenant-self.dto';
import { ErrorCode } from '../../common/errors/error-codes';
import { normalizeAccountNumber } from '../../common/utils/bank-account';
import { OrderStatus } from '../../common/constants/order-status';
import {
  PaymentMethod,
  PaymentRecordStatus,
} from '../../common/constants/payment-method';
import { SepayAccountSyncService } from './sepay-account-sync.service';

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

/** A shop reading and editing its own record. Never takes a tenant id from the caller; `TenantService` is the admin side. */
@Injectable()
export class TenantSelfService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationService,
    private readonly sepaySync: SepayAccountSyncService,
  ) {}

  /** The shop's own record, with `hasSepayKey` instead of the key itself: the settings screen needs to show whether the account is linked, and nothing needs the secret back. */
  async findMine(tenantId: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: {
        ...TENANT_SELECT,
        bankingSepayWebhookApiKey: true,
        bankingSepayLinkedAt: true,
      },
    });
    if (!tenant)
      throw new NotFoundException({
        code: ErrorCode.TENANT_NOT_FOUND,
        message: 'Shop not found',
      });

    const { bankingSepayWebhookApiKey, bankingSepayLinkedAt, ...rest } = tenant;
    return {
      ...withNestedBanking(rest),
      hasSepayKey: isSepayLinked({
        bankingSepayWebhookApiKey,
        bankingSepayLinkedAt,
      }),
    };
  }

  /** `PUT /tenant/me`. Sends the operators a heads-up when the bank account changes. */
  async updateMine(tenantId: string, dto: UpdateMyTenantDto) {
    const before = await this.bankingOf(tenantId);
    const banking = dto.banking
      ? await this.bankingWrite(tenantId, before, dto.banking)
      : {};

    const tenant = await this.prisma.tenant.update({
      where: { id: tenantId },
      data: {
        name: dto.name,
        phoneNumber: dto.phoneNumber,
        mainAddress: dto.mainAddress,
        taxNumber: dto.taxNumber,
        ...banking,
      },
      select: TENANT_SELECT,
    });

    if (dto.banking) await this.afterBankChange(before, tenant);
    return withNestedBanking(tenant);
  }

  /** `PUT /tenant/banking` - the same write on its own route, as the old API had it. */
  async updateBanking(tenantId: string, dto: BankingDto) {
    const before = await this.bankingOf(tenantId);

    const tenant = await this.prisma.tenant.update({
      where: { id: tenantId },
      data: await this.bankingWrite(tenantId, before, dto),
      select: TENANT_SELECT,
    });

    await this.afterBankChange(before, tenant);
    return withNestedBanking(tenant);
  }

  /** The webhook finds a shop by its account, so a number belongs to one shop and can't move while a QR printed with it awaits payment. SePay watched the old number, so changing it unlinks the shop. */
  private async bankingWrite(
    tenantId: string,
    before: BankingSnapshot,
    dto: BankingDto,
  ) {
    const accountNumber = normalizeAccountNumber(dto.accountNumber);
    const numberChanged =
      accountNumber !== normalizeAccountNumber(before.bankingAccountNumber);

    if (numberChanged) {
      const taken = await this.prisma.tenant.findFirst({
        where: { bankingAccountNumber: accountNumber, id: { not: tenantId } },
        select: { id: true },
      });
      if (taken) {
        throw new ConflictException({
          code: ErrorCode.TENANT_BANKING_ACCOUNT_TAKEN,
          message: 'Another shop already receives payments into this account',
        });
      }
      if (before.bankingAccountNumber) {
        await this.assertNoPendingSepay(tenantId);
      }
    }

    return {
      bankingAccountNumber: accountNumber,
      bankingBankName: dto.bankName,
      bankingAccountName: dto.accountName,
      ...(numberChanged
        ? { bankingSepayLinkedAt: null, bankingSepayWebhookApiKey: null }
        : {}),
    };
  }

  private async assertNoPendingSepay(tenantId: string) {
    const [orders, payments] = await Promise.all([
      this.prisma.order.count({
        where: {
          tenantId,
          status: OrderStatus.PENDING,
          paymentMethod: PaymentMethod.SEPAY,
        },
      }),
      this.prisma.payment.count({
        where: {
          tenantId,
          method: PaymentMethod.SEPAY,
          status: PaymentRecordStatus.PENDING,
        },
      }),
    ]);
    if (orders + payments > 0) {
      throw new ConflictException({
        code: ErrorCode.TENANT_BANKING_HAS_PENDING_SEPAY,
        message: `The shop has ${orders + payments} SePay payment(s) still waiting on the current account`,
        errors: { pendingOrders: orders, pendingPayments: payments },
      });
    }
  }

  /** Not awaited: the save must not wait on SePay. The owner hears through `SEPAY_LINKED`. */
  private async afterBankChange(
    before: BankingSnapshot,
    after: BankingSnapshot & { name: string },
  ) {
    await this.announceBankChange(before, after);
    if (bankingChanged(before, after) && hasBankInfo(after)) {
      void this.sepaySync.syncQuietly();
    }
  }

  /** Admin-only: the key identifies a tenant to the payment webhook. */
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
