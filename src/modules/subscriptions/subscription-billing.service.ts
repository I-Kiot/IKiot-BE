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
  QR_EXPIRY_MS,
} from './subscription.constants';
import type {
  Plan,
  Subscription,
  SubscriptionInvoice,
} from '../../../generated/prisma/client';
import { ErrorCode } from '../../common/errors/error-codes';

export interface SepayWebhookPayload {
  transferType?: string;
  accountNumber?: string | null;
  subAccount?: string | null;
  content?: string;
  transferAmount?: number;
  referenceCode?: string;
  id?: number | string;
}

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

    const paymentReference = this.sepay.extractReference(payload.content ?? '');
    if (!paymentReference) {
      return { success: true, message: 'No matching reference found' };
    }

    const invoice = await this.prisma.subscriptionInvoice.findFirst({
      where: { paymentReference, status: 'PENDING' },
    });
    if (!invoice) {
      return {
        success: true,
        message: 'Invoice not found or already processed',
      };
    }

    if ((payload.transferAmount ?? 0) < Number(invoice.amount)) {
      this.logger.warn(
        `Underpaid invoice ${invoice.id}. Expected ${invoice.amount.toString()}, got ${payload.transferAmount}`,
      );
      return { success: true, message: 'Underpaid - ignored' };
    }

    const subscription = await this.activateAfterPayment(invoice, payload);

    const owners = await this.notifications.tenantOwners(invoice.tenantId);
    await this.notifications.notify({
      tenantId: invoice.tenantId,
      recipientIds: owners,
      referenceId: invoice.id,
      ...SubscriptionNotificationTemplates.activated(),
    });
    this.realtime.emitToRoom(
      `tenant:${invoice.tenantId}`,
      'subscription:activated',
      {
        invoiceId: invoice.id,
        planId: subscription.planId,
        status: subscription.status,
        endDate: subscription.endDate,
      },
    );

    return { success: true, message: 'Subscription activated' };
  }

  private async activateAfterPayment(
    invoice: SubscriptionInvoice,
    sepayPayload: SepayWebhookPayload,
  ): Promise<Subscription> {
    const plan = await this.prisma.plan.findUnique({
      where: { id: invoice.planId },
    });
    if (!plan) throw new Error('Plan not found');

    const subscription = await this.prisma.subscription.findUnique({
      where: { id: invoice.subscriptionId },
    });
    if (!subscription) throw new Error('Subscription not found');

    const oldPlanId = subscription.planId;
    const isRenewal = oldPlanId === invoice.planId;

    const billingStart = new Date();
    const billingEnd = addDays(billingStart, getBillingDays(plan.billingCycle));

    const [updatedSubscription] = await this.prisma.$transaction([
      this.prisma.subscription.update({
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
              changedAt: new Date(),
              // Kích hoạt do webhook không có người thao tác. Bản cũ ghi tenantId vào đây, dễ bị đọc nhầm thành "người đổi".
              changedById: null,
              note: isRenewal
                ? `Renewed ${plan.planCode} via SePay (ref: ${invoice.paymentReference})`
                : `Upgraded to ${plan.planCode} via SePay (ref: ${invoice.paymentReference})`,
            },
          },
        },
      }),
      this.prisma.subscriptionInvoice.update({
        where: { id: invoice.id },
        data: {
          status: 'PAID',
          paidAt: new Date(),
          transactionRef:
            sepayPayload.referenceCode ?? String(sepayPayload.id ?? ''),
        },
      }),
    ]);

    return updatedSubscription;
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
