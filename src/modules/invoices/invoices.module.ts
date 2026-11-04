import { Module } from '@nestjs/common';
import { InvoiceController } from './invoices.controller';
import { InvoiceService } from './invoices.service';
import { InvoiceReadService } from './invoices-read.service';

@Module({
  controllers: [InvoiceController],
  providers: [InvoiceService, InvoiceReadService],
  // InvoiceService được route đơn hàng gọi trong chính transaction của chúng.
  exports: [InvoiceService],
})
export class InvoiceModule {}
