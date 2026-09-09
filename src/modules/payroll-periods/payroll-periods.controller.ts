import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PayrollPeriodService } from './payroll-periods.service';
import {
  GeneratePayrollDto,
  PayrollActionDto,
  PreviewPayrollDto,
  QueryPayrollPeriodDto,
  UpdateDraftPayslipDto,
} from './dto/payroll-period.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Permissions } from '../../common/decorators/permissions.decorator';
import { requireTenantId } from '../../common/utils/tenant-scope';
import type { AuthUser } from '../../common/types/auth-user.type';

/** Nine routes at the old paths, under `/payroll`. The five transitions are separate routes rather than one `PATCH ?action=`, which is how the old API had them and what lets each carry its own permission later. */
@ApiTags('payroll')
@ApiBearerAuth('bearer')
@Controller('payroll')
export class PayrollPeriodController {
  constructor(private readonly service: PayrollPeriodService) {}

  /** A what-if, taking either an explicit range or a month; nothing is written, which is why it is gated on `read` rather than `create`. */
  @Permissions('payroll', 'read')
  @HttpCode(HttpStatus.OK)
  @Post('preview')
  preview(
    @CurrentUser() user: AuthUser,
    @Body() body: PreviewPayrollDto & GeneratePayrollDto,
  ) {
    const tenantId = requireTenantId(user);
    return body.payrollMonth
      ? this.service.previewMonth(tenantId, body)
      : this.service.preview(tenantId, body);
  }

  @Permissions('payroll', 'create')
  @Post('periods')
  generate(@CurrentUser() user: AuthUser, @Body() dto: GeneratePayrollDto) {
    return this.service.generate(requireTenantId(user), user.userId, dto);
  }

  @Permissions('payroll', 'read')
  @Get('periods')
  findAll(
    @CurrentUser() user: AuthUser,
    @Query() query: QueryPayrollPeriodDto,
  ) {
    return this.service.findAll(requireTenantId(user), query);
  }

  @Permissions('payroll', 'read')
  @Get('periods/:periodId')
  findOne(
    @CurrentUser() user: AuthUser,
    @Param('periodId') periodId: string,
    @Query() query: QueryPayrollPeriodDto,
  ) {
    return this.service.findOne(requireTenantId(user), periodId, query);
  }

  @Permissions('payroll', 'read')
  @Get('periods/:periodId/payslips/:payslipId')
  findPayslip(
    @CurrentUser() user: AuthUser,
    @Param('periodId') periodId: string,
    @Param('payslipId') payslipId: string,
  ) {
    return this.service.findPayslip(requireTenantId(user), periodId, payslipId);
  }

  @Permissions('payroll', 'update')
  @Patch('periods/:periodId/payslips/:payslipId')
  updateDraftPayslip(
    @CurrentUser() user: AuthUser,
    @Param('periodId') periodId: string,
    @Param('payslipId') payslipId: string,
    @Body() dto: UpdateDraftPayslipDto,
  ) {
    return this.service.updateDraftPayslip(
      requireTenantId(user),
      user.userId,
      periodId,
      payslipId,
      dto,
    );
  }

  @Permissions('payroll', 'update')
  @HttpCode(HttpStatus.OK)
  @Post('periods/:periodId/submit')
  submit(
    @CurrentUser() user: AuthUser,
    @Param('periodId') periodId: string,
    @Body() dto: PayrollActionDto,
  ) {
    return this.service.changeStatus(
      requireTenantId(user),
      user.userId,
      periodId,
      'SUBMIT',
      dto,
    );
  }

  @Permissions('payroll', 'update')
  @HttpCode(HttpStatus.OK)
  @Post('periods/:periodId/return-to-draft')
  returnToDraft(
    @CurrentUser() user: AuthUser,
    @Param('periodId') periodId: string,
    @Body() dto: PayrollActionDto,
  ) {
    return this.service.changeStatus(
      requireTenantId(user),
      user.userId,
      periodId,
      'RETURN_TO_DRAFT',
      dto,
    );
  }

  @Permissions('payroll', 'update')
  @HttpCode(HttpStatus.OK)
  @Post('periods/:periodId/cancel')
  cancel(
    @CurrentUser() user: AuthUser,
    @Param('periodId') periodId: string,
    @Body() dto: PayrollActionDto,
  ) {
    return this.service.changeStatus(
      requireTenantId(user),
      user.userId,
      periodId,
      'CANCEL',
      dto,
    );
  }

  @Permissions('payroll', 'update')
  @HttpCode(HttpStatus.OK)
  @Post('periods/:periodId/approve')
  approve(
    @CurrentUser() user: AuthUser,
    @Param('periodId') periodId: string,
    @Body() dto: PayrollActionDto,
  ) {
    return this.service.changeStatus(
      requireTenantId(user),
      user.userId,
      periodId,
      'APPROVE',
      dto,
    );
  }

  /** Writes the CashFlow expense row and flips the status in one transaction. */
  @Permissions('payroll', 'update')
  @HttpCode(HttpStatus.OK)
  @Post('periods/:periodId/mark-paid')
  markPaid(
    @CurrentUser() user: AuthUser,
    @Param('periodId') periodId: string,
    @Body() dto: PayrollActionDto,
  ) {
    return this.service.changeStatus(
      requireTenantId(user),
      user.userId,
      periodId,
      'MARK_PAID',
      dto,
    );
  }
}
