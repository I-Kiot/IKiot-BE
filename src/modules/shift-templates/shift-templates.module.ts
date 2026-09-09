import { Module } from '@nestjs/common';
import { ShiftTemplateController } from './shift-templates.controller';
import { ShiftTemplateService } from './shift-templates.service';

@Module({
  controllers: [ShiftTemplateController],
  providers: [ShiftTemplateService],
  exports: [ShiftTemplateService],
})
export class ShiftTemplateModule {}
