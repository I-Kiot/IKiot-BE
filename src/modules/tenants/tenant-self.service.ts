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
import {
  diffBanking,
  recordBankingChange,
  type BankingState,
} from './tenant-banking-history';
import { TenantBankingChangeSource } from '../../common/constants/tenant-banking-change';
import { Prisma } from '../../../generated/prisma/client';
import { paginate, skipFor } from '../../common/utils/pagination';
import { withNestedProfile } from '../../common/utils/user-profile';
import { QueryBankingHistoryDto } from './dto/query-banking-history.dto';

const BANKING_STATE_SELECT = {
  bankingAccountNumber: true,
  bankingBankName: true,
  bankingAccountName: true,
  bankingSepayLinkedAt: true,
  bankingSepayWebhookApiKey: true,
} as const satisfies Prisma.TenantSelect;

interface BankingSnapshot {
  bankingAccountNumber: string | null;
  bankingBankName: string | null;
  bankingAccountName: string | null;
}

function bankingChanged(before: BankingSnapshot, after: BankingSnapshot) {
  return (
    before.bankingAccountNumber !== after.bankingAccountNumber ||
    before.bankingBankName !== after.bankingBankName ||
    before.bankingAccountName !== after.bankingAccountName
  );
}

function hasBankInfo(banking: BankingSnapshot) {
  return Boolean(banking.bankingAccountNumber && banking.bankingBankName);
}

/** Shop đọc và sửa hồ sơ của chính mình. Không bao giờ nhận tenant id từ caller; `TenantService` là phía admin. */
@Injectable()
export class TenantSelfService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationService,
    private readonly sepaySync: SepayAccountSyncService,
  ) {}

  /** Hồ sơ của shop, với `hasSepayKey` thay cho key: màn cài đặt cần biết đã liên kết chưa, và không cần trả key bí mật về. */
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

  /** `PUT /tenant/me`. Báo cho operator khi tài khoản ngân hàng đổi. */
  async updateMine(tenantId: string, actorId: string, dto: UpdateMyTenantDto) {
    const before = await this.bankingOf(tenantId);
    const banking = dto.banking
      ? await this.bankingWrite(tenantId, before, dto.banking)
      : {};

    const tenant = await this.updateWithHistory(
      tenantId,
      actorId,
      TenantBankingChangeSource.OWNER,
      {
        name: dto.name,
        phoneNumber: dto.phoneNumber,
        mainAddress: dto.mainAddress,
        taxNumber: dto.taxNumber,
        ...banking,
      },
    );

    if (dto.banking) await this.afterBankChange(before, tenant);
    return withNestedBanking(tenant);
  }

  /** `PUT /tenant/banking`: cùng thao tác ghi như `PUT /tenant/me`, tách route riêng như API cũ. */
  async updateBanking(tenantId: string, actorId: string, dto: BankingDto) {
    const before = await this.bankingOf(tenantId);

    const tenant = await this.updateWithHistory(
      tenantId,
      actorId,
      TenantBankingChangeSource.OWNER,
      await this.bankingWrite(tenantId, before, dto),
    );

    await this.afterBankChange(before, tenant);
    return withNestedBanking(tenant);
  }

  /** Ghi hồ sơ shop và, nếu cột nhận tiền đổi (kể cả liên kết SePay / key bị xoá theo), một dòng `tenant_banking_changes` trong cùng transaction. Ảnh trước đọc LẠI trong transaction, nên hai lần lưu đua nhau không ghi cùng một "từ". */
  private async updateWithHistory(
    tenantId: string,
    actorId: string | null,
    source: TenantBankingChangeSource,
    data: Prisma.TenantUpdateInput,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const before: BankingState | null = await tx.tenant.findUnique({
        where: { id: tenantId },
        select: BANKING_STATE_SELECT,
      });
      const tenant = await tx.tenant.update({
        where: { id: tenantId },
        data,
        select: { ...TENANT_SELECT, ...BANKING_STATE_SELECT },
      });
      if (before) {
        await recordBankingChange(tx, {
          tenantId,
          actorId,
          source,
          changes: diffBanking(before, tenant),
        });
      }
      // Key webhook và mốc liên kết chỉ phục vụ lịch sử: không được lọt ra response (xem TENANT_SELECT).
      const {
        bankingSepayWebhookApiKey: _key,
        bankingSepayLinkedAt: _linkedAt,
        ...safe
      } = tenant;
      return safe;
    });
  }

  /** Webhook tìm shop theo tài khoản, nên một số chỉ thuộc một shop và không được đổi khi QR in với số đó còn chờ thanh toán. SePay đang theo dõi số cũ, nên đổi số sẽ huỷ liên kết shop. */
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

  /** Không await: lưu không được chờ SePay. Chủ shop được báo qua `SEPAY_LINKED`. */
  private async afterBankChange(
    before: BankingSnapshot,
    after: BankingSnapshot & { name: string },
  ) {
    await this.announceBankChange(before, after);
    if (bankingChanged(before, after) && hasBankInfo(after)) {
      void this.sepaySync.syncQuietly();
    }
  }

  /** Chỉ admin: key định danh tenant với webhook thanh toán. */
  async setSepayKey(
    tenantId: string,
    actorId: string,
    sepayWebhookApiKey: string,
  ) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true },
    });
    if (!tenant)
      throw new NotFoundException({
        code: ErrorCode.TENANT_NOT_FOUND,
        message: 'Shop not found',
      });

    await this.updateWithHistory(
      tenantId,
      actorId,
      TenantBankingChangeSource.ADMIN,
      { bankingSepayWebhookApiKey: sepayWebhookApiKey },
    );

    const owners = await this.notifications.tenantOwners(tenantId);
    await this.notifications.notify({
      tenantId,
      recipientIds: owners,
      referenceId: tenantId,
      ...TenantNotificationTemplates.sepayLinked(),
    });

    return { message: 'SePay key saved' };
  }

  /** `GET /tenant/banking/history`: ai đổi tài khoản nhận tiền / key SePay / liên kết SePay và đổi từ gì sang gì. Mới nhất trước. Key webhook không bao giờ nằm trong đây, chỉ có `keyChanged`. */
  async bankingHistory(tenantId: string, query: QueryBankingHistoryDto) {
    const where: Prisma.TenantBankingChangeWhereInput = { tenantId };
    const [rows, total] = await Promise.all([
      this.prisma.tenantBankingChange.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: skipFor(query.page, query.limit),
        take: query.limit,
        include: {
          changedBy: {
            select: {
              id: true,
              phoneNumber: true,
              profileFirstName: true,
              profileLastName: true,
            },
          },
        },
      }),
      this.prisma.tenantBankingChange.count({ where }),
    ]);
    const data = rows.map(({ changedBy, changedById: _by, ...row }) => ({
      ...row,
      changedBy: changedBy ? withNestedProfile(changedBy) : null,
    }));
    return paginate(data, total, query.page, query.limit);
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

  /** Chỉ thông báo khi thông tin thực sự đổi và đã đủ để liên kết. */
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
