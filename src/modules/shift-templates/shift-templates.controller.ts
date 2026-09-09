import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ShiftTemplateService } from './shift-templates.service';
import {
  QueryShiftTemplateDto,
  ShiftTemplateDto,
} from './dto/shift-template.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Permissions } from '../../common/decorators/permissions.decorator';
import { requireTenantId } from '../../common/utils/tenant-scope';
import type { AuthUser } from '../../common/types/auth-user.type';

/** Five routes at the old paths, gated on `schedules:*` rather than a resource of their own - a shift template is part of scheduling, as the old routes had it. */
@ApiTags('shift-templates')
@ApiBearerAuth('bearer')
@Controller('shift-templates')
export class ShiftTemplateController {
  constructor(private readonly service: ShiftTemplateService) {}

  @Permissions('schedules', 'read')
  @Get()
  findAll(
    @CurrentUser() user: AuthUser,
    @Query() query: QueryShiftTemplateDto,
  ) {
    return this.service.findAll(requireTenantId(user), query);
  }

  @Permissions('schedules', 'read')
  @Get(':id')
  findOne(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.service.findOne(requireTenantId(user), id);
  }

  @Permissions('schedules', 'create')
  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: ShiftTemplateDto) {
    return this.service.create(requireTenantId(user), dto);
  }

  @Permissions('schedules', 'update')
  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: ShiftTemplateDto,
  ) {
    return this.service.update(requireTenantId(user), id, dto);
  }

  @Permissions('schedules', 'delete')
  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.service.remove(requireTenantId(user), id);
  }
}
