import { Body, Controller, Get, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PayrollSettingService } from './payroll-settings.service';
import {
  CreatePayrollSettingDto,
  UpdatePayrollSettingDto,
} from './dto/payroll-setting.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Permissions } from '../../common/decorators/permissions.decorator';
import { requireTenantId } from '../../common/utils/tenant-scope';
import type { AuthUser } from '../../common/types/auth-user.type';

// Three routes at the old paths, under /payroll/settings. One row per tenant, so there is no id in any of them.
@ApiTags('payroll')
@ApiBearerAuth('bearer')
@Controller('payroll/settings')
export class PayrollSettingController {
  constructor(private readonly service: PayrollSettingService) {}

  @Permissions('payrollSettings', 'read')
  @Get()
  findOne(@CurrentUser() user: AuthUser) {
    return this.service.findOne(requireTenantId(user));
  }

  @Permissions('payrollSettings', 'create')
  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreatePayrollSettingDto) {
    return this.service.create(requireTenantId(user), dto);
  }

  @Permissions('payrollSettings', 'update')
  @Put()
  update(@CurrentUser() user: AuthUser, @Body() dto: UpdatePayrollSettingDto) {
    return this.service.update(requireTenantId(user), dto);
  }
}
