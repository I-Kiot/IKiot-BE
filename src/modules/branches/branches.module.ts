import { Module } from '@nestjs/common';
import { BranchController } from './branches.controller';
import { BranchService } from './branches.service';
import { SubscriptionModule } from '../subscriptions/subscriptions.module';

@Module({
  // SubscriptionModule provides the plan quota gate applied when creating a branch.
  imports: [SubscriptionModule],
  controllers: [BranchController],
  providers: [BranchService],
  exports: [BranchService],
})
export class BranchModule {}
