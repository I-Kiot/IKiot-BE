import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { PlanService } from './plans.service';
import { Public } from '../../common/decorators/public.decorator';

@ApiTags('plans')
@Controller('plans')
export class PlanController {
  constructor(private readonly service: PlanService) {}

  @Public()
  @Get()
  findAll() {
    return this.service.listActive();
  }
}
