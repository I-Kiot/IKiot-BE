import { Module } from '@nestjs/common';
import { BranchController } from './branches.controller';
import { BranchService } from './branches.service';
import { SubscriptionModule } from '../subscriptions/subscriptions.module';

@Module({
  // SubscriptionModule cung cấp cổng hạn mức gói khi tạo chi nhánh.
  imports: [SubscriptionModule],
  controllers: [BranchController],
  providers: [BranchService],
  exports: [BranchService],
})
export class BranchModule {}
