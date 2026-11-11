import {
  Body,
  Controller,
  Get,
  Param,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { TenantSelfService } from './tenant-self.service';
import { QueryBankingHistoryDto } from './dto/query-banking-history.dto';
import {
  BankingDto,
  SetSepayKeyDto,
  UpdateMyTenantDto,
} from './dto/tenant-self.dto';
import { Permissions } from '../../common/decorators/permissions.decorator';
import { AdminOnlyGuard } from '../../common/guards/admin-only.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { requireTenantId } from '../../common/utils/tenant-scope';
import type { AuthUser } from '../../common/types/auth-user.type';

/** Cài đặt của chính shop, ở đường dẫn số ít `/tenant/*` như API cũ. Tenant id luôn lấy từ `requireTenantId(user)`, nên không route nào trỏ được sang shop khác; `/tenants` là CRUD riêng cho admin. */
@ApiTags('tenants')
@ApiBearerAuth('bearer')
@Controller('tenant')
export class TenantSelfController {
  constructor(private readonly service: TenantSelfService) {}

  /** Xem shop của mình chỉ cần thuộc shop đó, không cần quyền thêm, như API cũ. */
  @Get('me')
  findMine(@CurrentUser() user: AuthUser) {
    return this.service.findMine(requireTenantId(user));
  }

  @Permissions('tenants', 'update')
  @Put('me')
  updateMine(@CurrentUser() user: AuthUser, @Body() dto: UpdateMyTenantDto) {
    return this.service.updateMine(requireTenantId(user), user.userId, dto);
  }

  /** Tài khoản SePay nhận tiền. Thiếu nó thì `POST /orders` từ chối đơn SEPAY. */
  @Permissions('tenants', 'update')
  @Put('banking')
  updateBanking(@CurrentUser() user: AuthUser, @Body() dto: BankingDto) {
    return this.service.updateBanking(requireTenantId(user), user.userId, dto);
  }

  /** Lịch sử đổi tài khoản nhận tiền, key và liên kết SePay của shop. Cùng quyền với sửa thông tin nhận tiền (`tenants:update`). */
  @Permissions('tenants', 'update')
  @Get('banking/history')
  bankingHistory(
    @CurrentUser() user: AuthUser,
    @Query() query: QueryBankingHistoryDto,
  ) {
    return this.service.bankingHistory(requireTenantId(user), query);
  }

  /** Chỉ admin nền tảng. Xem `TenantSelfService.setSepayKey` vì sao guard này là sửa lỗi chứ không phải port. Tenant id nằm trên path vì operator đang thao tác trên shop của người khác. */
  @UseGuards(AdminOnlyGuard)
  @Put(':tenantId/sepay-key')
  setSepayKey(
    @CurrentUser() user: AuthUser,
    @Param('tenantId') tenantId: string,
    @Body() dto: SetSepayKeyDto,
  ) {
    return this.service.setSepayKey(
      tenantId,
      user.userId,
      dto.sepayWebhookApiKey,
    );
  }
}
