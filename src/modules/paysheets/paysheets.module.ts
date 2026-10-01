import { Module } from '@nestjs/common';
import { PaysheetController } from './paysheets.controller';
import { PaysheetService } from './paysheets.service';

@Module({
  controllers: [PaysheetController],
  providers: [PaysheetService],
  exports: [PaysheetService],
})
export class PaysheetModule {}
