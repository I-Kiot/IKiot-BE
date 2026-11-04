import {
  BadGatewayException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationService } from '../notifications/notifications.service';
import { TenantNotificationTemplates } from '../notifications/templates/tenant.templates';
import { ErrorCode } from '../../common/errors/error-codes';
import { SystemRole } from '../../common/constants/system-role';
import { UserStatus } from '../../common/constants/user-status';
import { VIETNAM_TIMEZONE } from '../../common/constants/timezone';
import {
  parseBankAccountList,
  planSepayLinks,
  type SepayBankAccount,
} from './sepay-account-sync';

const DEFAULT_BASE_URL = 'https://userapi.sepay.vn/v2';
const PAGE_SIZE = 100;
/** Chặn `has_more` chạy vô hạn: 5.000 tài khoản đã vượt xa số shop mà một nền tảng liên kết. */
const MAX_PAGES = 50;

/** Đánh dấu shop đã liên kết khi tài khoản của shop xuất hiện trên tài khoản SePay của nền tảng; webhook dùng chung đã phục vụ phần này. */
@Injectable()
export class SepayAccountSyncService {
  private readonly logger = new Logger(SepayAccountSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationService,
  ) {}

  /** Ném lỗi khi không đọc được SePay: nếu coi lỗi đọc là "không có tài khoản" thì mọi shop sẽ bị huỷ liên kết. */
  async sync(): Promise<{
    accounts: number;
    linked: string[];
    unlinked: string[];
  }> {
    const accounts = await this.fetchAccounts();
    const tenants = await this.prisma.tenant.findMany({
      where: {
        OR: [
          { bankingAccountNumber: { not: null } },
          { bankingSepayLinkedAt: { not: null } },
        ],
      },
      select: {
        id: true,
        bankingAccountNumber: true,
        bankingSepayLinkedAt: true,
      },
    });
    const { link, unlink } = planSepayLinks(tenants, accounts);

    if (link.length > 0 || unlink.length > 0) {
      await this.prisma.$transaction([
        this.prisma.tenant.updateMany({
          where: { id: { in: link }, bankingSepayLinkedAt: null },
          data: { bankingSepayLinkedAt: new Date() },
        }),
        this.prisma.tenant.updateMany({
          where: { id: { in: unlink } },
          data: { bankingSepayLinkedAt: null },
        }),
      ]);
    }
    if (unlink.length > 0) {
      this.logger.warn(
        `SePay no longer watches the account of tenant(s) ${unlink.join(', ')} - marked unlinked.`,
      );
    }
    await this.announceLinked(link);

    return { accounts: accounts.length, linked: link, unlinked: unlink };
  }

  /** Dùng cho cron và lúc lưu banking: SePay lỗi không được làm hỏng request đó. */
  async syncQuietly(): Promise<void> {
    // Máy dev có thể có token thật trong .env; test không được gọi SePay.
    if (process.env.NODE_ENV === 'test') return;
    if (!process.env.SEPAY_API_KEY?.trim()) return;
    try {
      await this.sync();
    } catch (error) {
      this.logger.warn(
        `SePay account sync failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  @Cron('*/10 * * * *', { timeZone: VIETNAM_TIMEZONE })
  async runPeriodicSync(): Promise<void> {
    await this.syncQuietly();
  }

  private async fetchAccounts(): Promise<SepayBankAccount[]> {
    const token = process.env.SEPAY_API_KEY?.trim();
    if (!token) {
      throw new ServiceUnavailableException({
        code: ErrorCode.SEPAY_API_NOT_CONFIGURED,
        message: 'SEPAY_API_KEY is not set',
      });
    }
    const baseUrl = (
      process.env.SEPAY_API_BASE_URL?.trim() || DEFAULT_BASE_URL
    ).replace(/\/+$/, '');

    const accounts: SepayBankAccount[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const body = await this.getJson(
        `${baseUrl}/bank-accounts?page=${page}&per_page=${PAGE_SIZE}`,
        token,
      );
      const rows = parseBankAccountList(body);
      if (!rows) {
        throw new BadGatewayException({
          code: ErrorCode.SEPAY_API_FAILED,
          message:
            'SePay answered the bank-account list with an unexpected body',
        });
      }
      accounts.push(...rows);
      if (!hasMorePages(body, rows.length)) return accounts;
    }
    return accounts;
  }

  private async getJson(url: string, token: string): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      throw new BadGatewayException({
        code: ErrorCode.SEPAY_API_FAILED,
        message: `SePay bank-account API unreachable: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    if (!response.ok) {
      throw new BadGatewayException({
        code: ErrorCode.SEPAY_API_FAILED,
        message: `SePay bank-account API answered ${response.status}`,
      });
    }
    return response.json();
  }

  private async announceLinked(tenantIds: string[]): Promise<void> {
    if (tenantIds.length === 0) return;
    const owners = await this.prisma.user.findMany({
      where: {
        tenantId: { in: tenantIds },
        systemRole: SystemRole.TENANT_OWNER,
        status: UserStatus.ACTIVE,
      },
      select: { id: true, tenantId: true },
    });
    for (const tenantId of tenantIds) {
      await this.notifications.notify({
        tenantId,
        recipientIds: owners
          .filter((owner) => owner.tenantId === tenantId)
          .map((owner) => owner.id),
        referenceId: tenantId,
        ...TenantNotificationTemplates.sepayLinked(),
      });
    }
  }
}

/** Không có `meta.pagination` thì chỉ khi trang đầy mới có khả năng còn trang sau. */
function hasMorePages(body: unknown, rowCount: number): boolean {
  const pagination = (
    body as { meta?: { pagination?: Record<string, unknown> } }
  ).meta?.pagination;
  if (!pagination) return rowCount >= PAGE_SIZE;
  if (typeof pagination.has_more === 'boolean') return pagination.has_more;
  const current = Number(pagination.current_page);
  const last = Number(pagination.last_page);
  return Number.isFinite(current) && Number.isFinite(last) && current < last;
}
