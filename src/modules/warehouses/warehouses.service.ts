import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SubscriptionService } from '../subscriptions/subscriptions.service';
import { LocationService } from '../locations/location.service';
import { MANAGER_SELECT } from '../locations/location.types';
import type { LocationConfig } from '../locations/location.types';
import type { Prisma } from '../../../generated/prisma/client';

type WarehouseRow = Prisma.WarehouseGetPayload<{
  include: { manager: { select: typeof MANAGER_SELECT } };
}>;

/** Everything that makes a warehouse a warehouse rather than a branch. */
const WAREHOUSE_CONFIG: LocationConfig = {
  quotaField: 'quotaSnapshotMaxWarehouses',
  postingField: 'warehouseId',
  otherPostingField: 'branchId',
  messages: {
    notFound: 'Warehouse not found',
    alreadyDeleted: 'This warehouse has already been deleted',
    quotaLabel: 'warehouses',
    staffStillAttached: (count) =>
      `Cannot delete this warehouse while ${count} employee(s) are still posted to it. Move them somewhere else first.`,
    staffNotEligible: 'The appointee must be an active employee of this shop',
    staffPostedElsewhere:
      'This employee is posted somewhere else. Move them to this warehouse before appointing them.',
  },
};

/** Ported from WarehouseService + WarehouseController and brought in line with BranchService, since a tenant runs several warehouses now. The old version accepted any active staff member as a manager, unlike its branch counterpart - which is why the shared LocationService exists: a rule can no longer be added to one of the pair and forgotten on the other. */
@Injectable()
export class WarehouseService extends LocationService<WarehouseRow> {
  constructor(prisma: PrismaService, subscriptions: SubscriptionService) {
    super(prisma, subscriptions, prisma.warehouse, WAREHOUSE_CONFIG);
  }

  /** Thin wrapper so the response keeps the `warehouseId` key the old API returned. */
  async assignManager(tenantId: string, warehouseId: string, staffId: string) {
    const manager = await this.appointManager(tenantId, warehouseId, staffId);
    return { warehouseId, manager };
  }
}
