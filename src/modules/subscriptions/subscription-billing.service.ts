import {
  BadRequestException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationService } from '../notifications/notifications.service';
import { SubscriptionNotificationTemplates } from '../notifications/templates/subscription.templates';
import { RealtimeGateway } from '../../common/realtime/realtime.gateway';
import { SepaySubscriptionService } from './sepay-subscription.service';
import { quotaSnapshotOf } from './subscriptions.service';
import { SubscriptionStatus } from './subscription-status';
import {
  addDays,
  getBillingDays,
  PlatformTransferOutcome,
  QR_EXPIRY_MS,
} from './subscription.constants';
import type {
  Plan,
  Subscription,
  SubscriptionInvoice,
} from '../../../generated/prisma/client';
import { ErrorCode } from '../../common/errors/error-codes';
import type { Prisma } from '../../../generated/prisma/client';
import { toDong } from '../../common/utils/money';
import {
  sepayTransferFromPayload,
  type SepayTransfer,
} from '../orders/sepay-qr';

export interface SepayWebhookPayload {
  transferType?: string;
  accountNumber?: string | null;
  subAccount?: string | null;
  content?: string;
  transferAmount?: number;
  referenceCode?: string;
  id?: number | string;
  transactionDate?: string;
}

/** Kết quả một lần chốt trong transaction (chưa gồm thông báo). */
interface PlatformSettlement {
  duplicate: boolean;
  outcome: PlatformTransferOutcome;
  invoiceId: string | null;
  tenantId?: string;
  subscription?: Subscription;
}

/** Lệnh chiếm hoá đơn thua (giao dịch khác vừa chốt): ném để cuốn cả dòng sổ rồi quyết định lại. */
class PlatformClaimLost extends Error {}

const PLATFORM_OUTCOME_MESSAGE: Record<PlatformTransferOutcome, string> = {
  ACTIVATED: 'Subscription activated',
  UNDERPAID: 'Underpaid - recorded, invoice stays pending',
  INVOICE_NOT_PENDING: 'Invoice not pending - recorded for reconciliation',
  UNMATCHED: 'No invoice with this reference - recorded for reconciliation',
  NO_REFERENCE: 'No matching reference found - recorded for reconciliation',
};

/** Kết quả trả về cho POST /webhook/sepay. Luôn HTTP 200, xem handleSepayWebhook. */
export interface SepayWebhookResult {
  success: boolean;
  message?: string;
}

/** Phần thu tiền của SubscriptionService cũ: xuất hoá đơn nâng cấp/gia hạn, và biến callback “tiền đã về” của SePay thành gói được kích hoạt. Tách riêng vì trạng thái gói, hạn mức, hoá đơn và webhook hầu như không dính nhau. */
@Injectable()
export class SubscriptionBillingService {
  private readonly logger = new Logger(SubscriptionBillingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sepay: SepaySubscriptionService,
    private readonly notifications: NotificationService,
    private readonly realtime: RealtimeGateway,
  ) {}

  async initiateUpgrade(tenantId: string, planCode: string) {
    const currentSubscription = await this.prisma.subscription.findFirst({
      where: { tenantId },
    });
    if (!currentSubscription)
      throw new BadRequestException({
        code: ErrorCode.SUBSCRIPTION_NOT_FOUND,
        message: 'No active subscription found',
      });

    const newPlan = await this.prisma.plan.findFirst({
      where: { planCode, isActive: true },
    });
    if (!newPlan)
      throw new BadRequestException({
        code: ErrorCode.PLAN_NOT_FOUND,
        message: `Plan ${planCode} not found or inactive`,
      });
    if (Number(newPlan.price) === 0)
      throw new BadRequestException({
        code: ErrorCode.PLAN_IS_FREE,
        message: 'Use free-trial endpoint for free plans',
      });

    return this.createPlanInvoice(currentSubscription, newPlan);
  }

  async initiateRenewal(tenantId: string) {
    const currentSubscription = await this.prisma.subscription.findFirst({
      where: { tenantId },
      include: { plan: true },
    });
    if (!currentSubscription)
      throw new BadRequestException({
        code: ErrorCode.SUBSCRIPTION_NOT_FOUND,
        message: 'No subscription found',
      });

    const currentPlan = currentSubscription.plan;
    if (!currentPlan)
      throw new BadRequestException({
        code: ErrorCode.PLAN_NOT_FOUND,
        message: 'Current plan not found',
      });
    if (currentPlan.planCode === 'TRIAL' || Number(currentPlan.price) === 0) {
      throw new BadRequestException({
        code: ErrorCode.TRIAL_CANNOT_RENEW,
        message: 'Trial plan cannot be renewed. Please upgrade to a paid plan.',
      });
    }

    return this.createPlanInvoice(currentSubscription, currentPlan);
  }

  /** SePay gọi khi tiền về tài khoản ngân hàng của iKiot. Mọi kết quả, trừ API key sai, đều trả về bình thường để controller luôn trả 200 và SePay không retry vào lỗi của ta; key sai là bên gọi lạ nên trả 401 thật. */
  async handleSepayWebhook(
    apiKey: string,
    payload: SepayWebhookPayload,
  ): Promise<SepayWebhookResult> {
    if (!this.sepay.verifyWebhookKey(apiKey)) {
      throw new UnauthorizedException({
        code: ErrorCode.WEBHOOK_API_KEY_INVALID,
        message: 'Invalid API key',
      });
    }

    try {
      return await this.settlePayment(payload);
    } catch (error) {
      this.logger.error(
        'SePay webhook error',
        error instanceof Error ? error.stack : error,
      );
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /** Phần việc thật của webhook, không kèm lớp bọc "không để SePay retry" bên ngoài. */
  private async settlePayment(
    payload: SepayWebhookPayload,
  ): Promise<SepayWebhookResult> {
    if (payload.transferType !== 'in') return { success: true };

    if (!this.sepay.isPlatformAccount(payload)) {
      return { success: true, message: 'Not the platform account - ignored' };
    }

    const transfer = sepayTransferFromPayload({ ...payload });
    const reference = this.sepay.extractReference(payload.content ?? '');

    // Một lần chạy lại: lệnh chiếm hoá đơn thua (có giao dịch khác kịp chốt) cuốn cả dòng sổ, rồi quyết định lại trên hoá đơn đã đổi.
    let result: PlatformSettlement | null = null;
    for (let attempt = 0; attempt < 2 && !result; attempt++) {
      try {
        result = await this.prisma.$transaction((tx) =>
          this.settleInTransaction(tx, transfer, reference),
        );
      } catch (error) {
        if (!(error instanceof PlatformClaimLost)) throw error;
      }
    }
    if (!result) throw new Error('Platform transfer could not be settled');

    if (result.duplicate) {
      return { success: true, message: 'Duplicate transaction' };
    }
    if (result.outcome === PlatformTransferOutcome.ACTIVATED) {
      await this.notifyActivated(result);
      return { success: true, message: 'Subscription activated' };
    }

    this.logger.warn(
      `Platform transfer ${transfer.sepayTransactionId ?? transfer.dedupeKey} (${transfer.amount}) needs action: ${result.outcome}`,
    );
    await this.notifications.notifySystem({
      ...SubscriptionNotificationTemplates.platformTransferNeedsAction(
        result.outcome,
        transfer.amount,
        reference,
        transfer.content,
      ),
      referenceId: result.invoiceId ?? undefined,
    });
    return { success: true, message: PLATFORM_OUTCOME_MESSAGE[result.outcome] };
  }

  /**
   * Một transaction cho mọi kết cục: đọc hoá đơn (mọi trạng thái), quyết định, chèn dòng sổ (`ON CONFLICT DO NOTHING` theo `dedupe_key`: trùng thì không làm gì thêm), rồi CHIẾM hoá đơn `PENDING -> PAID` trước khi động tới gói.
   * Thứ tự này là chốt chặn chống webhook gọi hai lần hay hai giao dịch cho cùng một hoá đơn: chỉ một bên chiếm được, bên kia nhận `INVOICE_NOT_PENDING` (sau khi chạy lại) và nằm trong sổ để admin xử lý.
   */
  private async settleInTransaction(
    tx: Prisma.TransactionClient,
    transfer: SepayTransfer,
    reference: string | null,
  ): Promise<PlatformSettlement> {
    const invoice = reference
      ? await tx.subscriptionInvoice.findUnique({
          where: { paymentReference: reference },
        })
      : null;

    let outcome: PlatformTransferOutcome;
    if (!reference) outcome = PlatformTransferOutcome.NO_REFERENCE;
    else if (!invoice) outcome = PlatformTransferOutcome.UNMATCHED;
    else if (invoice.status !== 'PENDING')
      outcome = PlatformTransferOutcome.INVOICE_NOT_PENDING;
    else if (toDong(transfer.amount) < toDong(invoice.amount))
      outcome = PlatformTransferOutcome.UNDERPAID;
    else outcome = PlatformTransferOutcome.ACTIVATED;

    const inserted = await tx.platformSepayTransaction.createMany({
      data: [
        {
          dedupeKey: transfer.dedupeKey,
          sepayTransactionId: transfer.sepayTransactionId,
          accountNumber: transfer.accountNumber,
          content: transfer.content,
          bankReferenceCode: transfer.bankReferenceCode,
          amount: transfer.amount,
          outcome,
          paymentReference: reference,
          subscriptionInvoiceId: invoice?.id ?? null,
          tenantId: invoice?.tenantId ?? null,
        },
      ],
      skipDuplicates: true,
    });
    if (inserted.count === 0) {
      return { duplicate: true, outcome, invoiceId: invoice?.id ?? null };
    }

    if (outcome === PlatformTransferOutcome.UNDERPAID && invoice) {
      await tx.subscriptionInvoice.updateMany({
        where: { id: invoice.id, status: 'PENDING' },
        data: { amountReceived: transfer.amount },
      });
    }
    if (outcome !== PlatformTransferOutcome.ACTIVATED || !invoice) {
      return { duplicate: false, outcome, invoiceId: invoice?.id ?? null };
    }

    const now = new Date();
    const claimed = await tx.subscriptionInvoice.updateMany({
      where: { id: invoice.id, status: 'PENDING' },
      data: {
        status: 'PAID',
        paidAt: now,
        amountReceived: transfer.amount,
        transactionRef:
          transfer.bankReferenceCode ?? transfer.sepayTransactionId,
      },
    });
    if (claimed.count !== 1) throw new PlatformClaimLost();

    const subscription = await this.activateSubscription(tx, invoice, now);
    return {
      duplicate: false,
      outcome,
      invoiceId: invoice.id,
      tenantId: invoice.tenantId,
      subscription,
    };
  }

  private async activateSubscription(
    tx: Prisma.TransactionClient,
    invoice: SubscriptionInvoice,
    billingStart: Date,
  ): Promise<Subscription> {
    const plan = await tx.plan.findUnique({ where: { id: invoice.planId } });
    if (!plan) throw new Error('Plan not found');

    const subscription = await tx.subscription.findUnique({
      where: { id: invoice.subscriptionId },
    });
    if (!subscription) throw new Error('Subscription not found');

    const oldPlanId = subscription.planId;
    const isRenewal = oldPlanId === invoice.planId;
    const billingEnd = addDays(billingStart, getBillingDays(plan.billingCycle));

    return tx.subscription.update({
      where: { id: subscription.id },
      data: {
        planId: plan.id,
        status: SubscriptionStatus.ACTIVE,
        startDate: billingStart,
        endDate: billingEnd,
        trialEndDate: null,
        ...quotaSnapshotOf(plan),
        historyLogs: {
          create: {
            event: isRenewal ? 'RENEWED' : 'UPGRADED',
            fromPlanId: oldPlanId,
            toPlanId: plan.id,
            changedAt: billingStart,
            // Kích hoạt do webhook không có người thao tác. Bản cũ ghi tenantId vào đây, dễ bị đọc nhầm thành "người đổi".
            changedById: null,
            note: isRenewal
              ? `Renewed ${plan.planCode} via SePay (ref: ${invoice.paymentReference})`
              : `Upgraded to ${plan.planCode} via SePay (ref: ${invoice.paymentReference})`,
          },
        },
      },
    });
  }

  private async notifyActivated(result: PlatformSettlement): Promise<void> {
    const { invoiceId, tenantId, subscription } = result;
    if (!invoiceId || !tenantId || !subscription) return;
    const owners = await this.notifications.tenantOwners(tenantId);
    await this.notifications.notify({
      tenantId,
      recipientIds: owners,
      referenceId: invoiceId,
      ...SubscriptionNotificationTemplates.activated(),
    });
    this.realtime.emitToRoom(`tenant:${tenantId}`, 'subscription:activated', {
      invoiceId,
      planId: subscription.planId,
      status: subscription.status,
      endDate: subscription.endDate,
    });
  }

  private async createPlanInvoice(
    subscription: Pick<Subscription, 'id' | 'tenantId'>,
    plan: Plan,
  ) {
    await this.prisma.subscriptionInvoice.updateMany({
      where: {
        tenantId: subscription.tenantId,
        planId: plan.id,
        status: 'PENDING',
      },
      data: { status: 'FAILED' },
    });

    const billingStart = new Date();
    const billingEnd = addDays(billingStart, getBillingDays(plan.billingCycle));
    const paymentReference = this.sepay.generatePaymentReference();

    const invoice = await this.prisma.subscriptionInvoice.create({
      data: {
        subscriptionId: subscription.id,
        tenantId: subscription.tenantId,
        planId: plan.id,
        amount: plan.price,
        currency: 'VND',
        status: 'PENDING',
        paymentReference,
        paymentMethod: 'SEPAY',
        billingPeriodStart: billingStart,
        billingPeriodEnd: billingEnd,
      },
    });

    const amount = Number(plan.price);
    return {
      invoiceId: invoice.id,
      paymentReference,
      amount,
      plan: { planCode: plan.planCode, planName: plan.planName },
      qrDataUrl: this.sepay.buildQrUrl(amount, paymentReference),
      expiredAt: new Date(Date.now() + QR_EXPIRY_MS),
    };
  }
}
