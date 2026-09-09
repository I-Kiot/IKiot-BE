import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PlanService } from './plans.service';
import { UpdatePlanDto } from './dto/update-plan.dto';
import { TogglePlanActiveDto } from './dto/toggle-plan-active.dto';
import { AdminOnlyGuard } from '../../common/guards/admin-only.guard';

@ApiTags('plans')
@ApiBearerAuth('bearer')
@UseGuards(AdminOnlyGuard)
@Controller('admin/plans')
export class AdminPlanController {
  constructor(private readonly service: PlanService) {}

  @Get()
  findAll() {
    return this.service.listAll();
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() dto: UpdatePlanDto) {
    return this.service.update(id, dto);
  }

  @Patch(':id/active')
  setActive(@Param('id') id: string, @Body() dto: TogglePlanActiveDto) {
    return this.service.setActive(id, dto.isActive);
  }
}
