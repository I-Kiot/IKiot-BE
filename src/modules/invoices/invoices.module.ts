import { Module } from '@nestjs/common';
import { InvoiceController } from './invoices.controller';
import { InvoiceService } from './invoices.service';
import { InvoiceReadService } from './invoices-read.service';

@Module({
  controllers: [InvoiceController],
  providers: [InvoiceService, InvoiceReadService],
  // InvoiceService is what the order routes call inside their own transactions.
  exports: [InvoiceService],
})
export class InvoiceModule {}
