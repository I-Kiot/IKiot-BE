import { Body, Controller, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PaysheetService } from './paysheets.service';
import { PaysheetDto, QueryPaysheetDto } from './dto/paysheet.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Permissions } from '../../common/decorators/permissions.decorator';
import { requireTenantId } from '../../common/utils/tenant-scope';
import type { AuthUser } from '../../common/types/auth-user.type';

// Four routes at the old paths, under /payroll/paysheets. No delete - payslips already generated point at a paysheet and have to stay explainable.
@ApiTags('payroll')
@ApiBearerAuth('bearer')
@Controller('payroll/paysheets')
export class PaysheetController {
  constructor(private readonly service: PaysheetService) {}

  @Permissions('paysheets', 'read')
  @Get()
  findAll(@CurrentUser() user: AuthUser, @Query() query: QueryPaysheetDto) {
    return this.service.findAll(requireTenantId(user), query);
  }

  @Permissions('paysheets', 'read')
  @Get(':id')
  findOne(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.service.findOne(requireTenantId(user), id);
  }

  @Permissions('paysheets', 'create')
  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: PaysheetDto) {
    return this.service.create(requireTenantId(user), user.userId, dto);
  }

  @Permissions('paysheets', 'update')
  @Put(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: PaysheetDto,
  ) {
    return this.service.update(requireTenantId(user), id, dto);
  }
}
