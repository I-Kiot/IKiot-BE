import { Module } from '@nestjs/common';
import { SepayTransactionController } from './sepay-transactions.controller';
import { SepayTransactionService } from './sepay-transactions.service';

@Module({
  controllers: [SepayTransactionController],
  providers: [SepayTransactionService],
})
export class SepayTransactionModule {}
