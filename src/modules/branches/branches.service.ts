import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SubscriptionService } from '../subscriptions/subscriptions.service';
import { LocationService } from '../locations/location.service';
import { MANAGER_SELECT } from '../locations/location.types';
import type { LocationConfig } from '../locations/location.types';
import type { Prisma } from '../../../generated/prisma/client';

type BranchRow = Prisma.BranchGetPayload<{
  include: { manager: { select: typeof MANAGER_SELECT } };
}>;

/** Everything that makes a branch a branch rather than a warehouse. */
const BRANCH_CONFIG: LocationConfig = {
  quotaField: 'quotaSnapshotMaxBranches',
  postingField: 'branchId',
  otherPostingField: 'warehouseId',
  messages: {
    notFound: 'Branch not found',
    alreadyDeleted: 'This branch has already been deleted',
    quotaLabel: 'branches',
    staffStillAttached: (count) =>
      `Cannot delete this branch while ${count} employee(s) are still posted to it. Move them to another branch first.`,
    staffNotEligible: 'The appointee must be an active employee of this shop',
    staffPostedElsewhere:
      'This employee is posted somewhere else. Move them to this branch before appointing them.',
  },
};

// Ported from BranchService + BranchController; the CRUD and manager appointment live in LocationService, shared with WarehouseService, because the two were 90% identical text and drifted apart in the old codebase.
@Injectable()
export class BranchService extends LocationService<BranchRow> {
  constructor(prisma: PrismaService, subscriptions: SubscriptionService) {
    super(prisma, subscriptions, prisma.branch, BRANCH_CONFIG);
  }

  /** Thin wrapper so the response keeps the `branchId` key the old API returned. */
  async assignManager(tenantId: string, branchId: string, staffId: string) {
    const manager = await this.appointManager(tenantId, branchId, staffId);
    return { branchId, manager };
  }
}
