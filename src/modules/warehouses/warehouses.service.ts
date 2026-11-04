import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SubscriptionService } from '../subscriptions/subscriptions.service';
import { LocationService } from '../locations/location.service';
import type { LocationConfig } from '../locations/location.types';
import { LocationType } from '../../common/constants/location-type';

const WAREHOUSE_CONFIG: LocationConfig = {
  kind: LocationType.WAREHOUSE,
  specialization: 'warehouse',
  quotaField: 'quotaSnapshotMaxWarehouses',
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

/** Port từ WarehouseService + WarehouseController, đồng bộ với BranchService vì tenant nay có nhiều kho. Bản cũ nhận mọi NV đang làm việc làm quản lý, khác bên chi nhánh; nên có LocationService dùng chung để một luật không bị thêm cho bên này mà quên bên kia. */
@Injectable()
export class WarehouseService extends LocationService {
  constructor(prisma: PrismaService, subscriptions: SubscriptionService) {
    super(prisma, subscriptions, WAREHOUSE_CONFIG);
  }

  /** Thin wrapper so the response keeps the `warehouseId` key the old API returned. */
  async assignManager(tenantId: string, warehouseId: string, staffId: string) {
    const manager = await this.appointManager(tenantId, warehouseId, staffId);
    return { warehouseId, manager };
  }
}
