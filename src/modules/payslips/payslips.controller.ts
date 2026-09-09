import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PayslipService } from './payslips.service';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Permissions } from '../../common/decorators/permissions.decorator';
import { requireTenantId } from '../../common/utils/tenant-scope';
import type { AuthUser } from '../../common/types/auth-user.type';

// Two routes at the old paths. `read_own` is the only permission here - there is no way to read somebody else's payslip through this controller.
@ApiTags('payroll')
@ApiBearerAuth('bearer')
@Controller('payroll/my-payslips')
export class PayslipController {
  constructor(private readonly service: PayslipService) {}

  @Permissions('payslips', 'read_own')
  @Get()
  findMine(@CurrentUser() user: AuthUser, @Query() query: PaginationQueryDto) {
    return this.service.findMine(requireTenantId(user), user.userId, query);
  }

  @Permissions('payslips', 'read_own')
  @Get(':id')
  findOne(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.service.findMineOne(requireTenantId(user), user.userId, id);
  }
}
