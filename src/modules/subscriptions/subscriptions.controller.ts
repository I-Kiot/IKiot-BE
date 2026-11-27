import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { SubscriptionService } from './subscriptions.service';
import { SubscriptionBillingService } from './subscription-billing.service';
import { UpgradeSubscriptionDto } from './dto/upgrade-subscription.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Permissions } from '../../common/decorators/permissions.decorator';
import { requireTenantId } from '../../common/utils/tenant-scope';
import { Public } from '../../common/decorators/public.decorator';
import { RawResponse } from '../../common/decorators/raw-response.decorator';
import { AdminOnlyGuard } from '../../common/guards/admin-only.guard';
import type { AuthUser } from '../../common/types/auth-user.type';

// Controller gói dịch vụ; mua, nâng cấp, gia hạn cần `subscriptions:manage`.
@ApiTags('subscriptions')
@Controller()
export class SubscriptionController {
  constructor(
    private readonly subscriptionService: SubscriptionService,
    private readonly billingService: SubscriptionBillingService,
  ) {}

  @ApiBearerAuth('bearer')
  @Permissions('subscriptions', 'manage')
  @Post('subscription/free-trial')
  async assignFreeTrial(@CurrentUser() user: AuthUser) {
    const data = await this.subscriptionService.assignFreeTrial(
      requireTenantId(user),
      user.userId,
    );
    return { message: 'Free trial assigned successfully', data };
  }

  @ApiBearerAuth('bearer')
  @Permissions('subscriptions', 'read')
  @Get('subscription/status')
  status(@CurrentUser() user: AuthUser) {
    return this.subscriptionService.checkTrialStatus(requireTenantId(user));
  }

  /** Gói hiện tại cho màn billing. */
  @ApiBearerAuth('bearer')
  @Permissions('subscriptions', 'read')
  @Get('subscription/current')
  current(@CurrentUser() user: AuthUser) {
    return this.subscriptionService.getCurrentSubscription(
      requireTenantId(user),
    );
  }

  @ApiBearerAuth('bearer')
  @Permissions('subscriptions', 'manage')
  @Post('subscription/upgrade/initiate')
  async initiateUpgrade(
    @CurrentUser() user: AuthUser,
    @Body() dto: UpgradeSubscriptionDto,
  ) {
    const data = await this.billingService.initiateUpgrade(
      requireTenantId(user),
      dto.planCode,
    );
    return {
      message:
        'Payment initiated. Scan QR or transfer with the reference code.',
      data,
    };
  }

  @ApiBearerAuth('bearer')
  @Permissions('subscriptions', 'manage')
  @Post('subscription/renew/initiate')
  async initiateRenewal(@CurrentUser() user: AuthUser) {
    const data = await this.billingService.initiateRenewal(
      requireTenantId(user),
    );
    return {
      message:
        'Renewal initiated. Scan QR or transfer with the reference code.',
      data,
    };
  }

  @ApiBearerAuth('bearer')
  @UseGuards(AdminOnlyGuard)
  @Post('subscription/upgrade/:tenantId')
  async adminUpgrade(
    @CurrentUser() user: AuthUser,
    @Param('tenantId') tenantId: string,
    @Body() dto: UpgradeSubscriptionDto,
  ) {
    const data = await this.subscriptionService.adminUpgradePlan(
      tenantId,
      user.userId,
      dto.planCode,
    );
    return { message: `Successfully upgraded to ${dto.planCode}`, data };
  }

  // Webhook SePay cho gói, luôn trả 200 trừ API key sai.
  @RawResponse()
  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('webhook/sepay')
  webhook(
    @Headers('authorization') authHeader: string | undefined,
    @Body() payload: Record<string, unknown>,
  ) {
    const apiKey = authHeader?.split(' ')[1] ?? '';
    return this.billingService.handleSepayWebhook(apiKey, payload);
  }
}
