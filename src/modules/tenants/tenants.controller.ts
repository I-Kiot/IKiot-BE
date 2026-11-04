import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { TenantService } from './tenants.service';
import { SepayAccountSyncService } from './sepay-account-sync.service';
import { CreateTenantDto } from './dto/create-tenants.dto';
import { UpdateTenantDto } from './dto/update-tenants.dto';
import { Permissions } from '../../common/decorators/permissions.decorator';
import { AdminOnlyGuard } from '../../common/guards/admin-only.guard';

// CRUD sinh tự động, chưa phải port thật. Chỉ admin nền tảng, và phải là guard chứ không phải `@Permissions`: `Tenant` không có `tenantId` để lọc, còn PermissionsGuard bỏ qua TENANT_OWNER, nên chỉ `@Permissions('tenants', …)` thì chủ shop nào cũng sửa được shop khác. Decorator giữ để cặp quyền có route trong scripts/check-permissions.js; guard mới là thứ chặn.
@ApiTags('tenants')
@ApiBearerAuth('bearer')
@UseGuards(AdminOnlyGuard)
@Controller('tenants')
export class TenantController {
  constructor(
    private readonly service: TenantService,
    private readonly sepaySync: SepayAccountSyncService,
  ) {}

  @Permissions('tenants', 'read')
  @Get()
  findAll() {
    return this.service.findAll();
  }

  /** Đọc lại SePay ngay, thay vì chờ cron 10 phút. */
  @Permissions('tenants', 'update')
  @Post('sepay-sync')
  @HttpCode(HttpStatus.OK)
  syncSepay() {
    return this.sepaySync.sync();
  }

  @Permissions('tenants', 'read')
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  @Permissions('tenants', 'create')
  @Post()
  create(@Body() dto: CreateTenantDto) {
    return this.service.create(dto);
  }

  @Permissions('tenants', 'update')
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateTenantDto) {
    return this.service.update(id, dto);
  }

  @Permissions('tenants', 'delete')
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }
}
