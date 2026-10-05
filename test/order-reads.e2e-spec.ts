import 'dotenv/config';
import { randomUUID } from 'crypto';
import { Test } from '@nestjs/testing';
import { PrismaModule } from './../src/prisma/prisma.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { OrderReadService } from './../src/modules/orders/order-read.service';
import { QueryOrderJourneyDto } from './../src/modules/orders/dto/query-order-journey.dto';
import {
  FulfillmentType,
  OrderItemStatus,
  OrderPriority,
  OrderStatus,
  RemittanceStatus,
} from './../src/common/constants/order-status';
import { SystemRole } from './../src/common/constants/system-role';
import { ErrorCode } from './../src/common/errors/error-codes';
import type { AuthUser } from './../src/common/types/auth-user.type';

/**
 * Kiểm thử đọc đơn (A-9, `GET /orders`, `GET /orders/:id` qua OrderReadService) trên Postgres thật:
 * lọc, sắp xếp (kể cả priority không theo alphabet và cắt trang qua các nhóm), stockSummary,
 * phạm vi chi nhánh, và hình dạng OrderListItem / OrderDetail. Tự tạo tenant riêng và dọn sạch,
 * nên chạy lại bao nhiêu lần cũng được.
 */
describe('GET /orders, GET /orders/:id – OrderReadService (A-9)', () => {
  let prisma: PrismaService;
  let reads: OrderReadService;

  const tenantId = randomUUID();
  const ownerId = randomUUID();
  const assigneeId = randomUUID();
  const shipperId = randomUUID();
  const branchA = randomUUID();
  const branchB = randomUUID();
  const warehouseId = randomUUID();
  const productId = randomUUID();
  const cabinetId = randomUUID(); // 3 ở kho, 2 đã khoá cho đơn PACKED → trên kệ 1
  const tableId = randomUUID(); // chưa từng có ở kho
  const customerId = randomUUID();

  const owner = {
    userId: ownerId,
    tenantId,
    systemRole: SystemRole.TENANT_OWNER,
    permissions: new Set<string>(),
    branchId: null,
    warehouseId: null,
  } as unknown as AuthUser;

  /** Nhân viên chi nhánh A, chỉ có `orders:read` – không có `view_all`. */
  const staffAtA = {
    ...owner,
    userId: assigneeId,
    systemRole: SystemRole.STAFF,
    permissions: new Set(['orders:read']),
    branchId: branchA,
  } as unknown as AuthUser;

  const query = (over: Partial<QueryOrderJourneyDto> = {}) =>
    Object.assign(new QueryOrderJourneyDto(), { page: 1, limit: 50 }, over);

  const codesOf = (result: { data: { code: string }[] }) =>
    result.data.map((order) => order.code);

  // Mã đơn: tiền tố theo tenant để `search` không đụng dữ liệu của test khác.
  const P = `RD${tenantId.slice(0, 6)}`;
  const ids: Record<string, string> = {};
  let minute = 0;

  async function createOrder(
    name: string,
    opts: {
      status: string;
      priority?: string;
      branchId?: string;
      fulfillmentType?: string;
      grandTotal?: number;
      depositAmount?: number;
      depositPercent?: number;
      requestedDeliveryDate?: string;
      shippedAt?: Date;
      lines: {
        productItemId: string;
        quantity: number;
        status?: string;
        custom?: boolean;
      }[];
    },
  ) {
    const id = randomUUID();
    ids[name] = id;
    await prisma.order.create({
      data: {
        id,
        code: `${P}-${name}`,
        tenantId,
        branchId: opts.branchId ?? branchA,
        customerId,
        userId: ownerId,
        assigneeId,
        status: opts.status,
        priority: opts.priority ?? OrderPriority.NORMAL,
        fulfillmentType: opts.fulfillmentType ?? FulfillmentType.HOME_DELIVERY,
        grandTotal: opts.grandTotal ?? 1_000_000,
        subtotal: opts.grandTotal ?? 1_000_000,
        depositAmount: opts.depositAmount,
        depositPercent: opts.depositPercent,
        requestedDeliveryDate: opts.requestedDeliveryDate
          ? new Date(opts.requestedDeliveryDate)
          : undefined,
        shippedAt: opts.shippedAt,
        // Mỗi đơn mới hơn đơn trước một phút – thứ tự mặc định đoán trước được.
        createdAt: new Date(Date.UTC(2026, 9, 1, 0, minute++)),
        items: {
          create: opts.lines.map((line) => ({
            productItemId: line.productItemId,
            sku: line.productItemId === cabinetId ? 'TU' : 'BAN',
            productName: line.productItemId === cabinetId ? 'Tủ' : 'Bàn',
            quantity: line.quantity,
            listUnitPrice: 500_000,
            unitPrice: 500_000,
            lineTotal: 500_000 * line.quantity,
            status: line.status ?? OrderItemStatus.PENDING,
            sourceLocationId: warehouseId,
            isCustom: line.custom ?? false,
          })),
        },
      },
    });
    return id;
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule],
      providers: [OrderReadService],
    }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    reads = moduleRef.get(OrderReadService);

    await prisma.tenant.create({ data: { id: tenantId, name: 'reads-e2e' } });
    for (const [id, first, last, role] of [
      [ownerId, 'Chủ', null, SystemRole.TENANT_OWNER],
      [assigneeId, 'Lan', 'Nguyễn', SystemRole.STAFF],
      [shipperId, null, null, SystemRole.STAFF],
    ] as const) {
      await prisma.user.create({
        data: {
          id,
          tenantId,
          phoneNumber: `rd-${id}`,
          systemRole: role,
          profileFirstName: first,
          profileLastName: last,
        },
      });
    }
    for (const [id, name] of [
      [branchA, 'CN A'],
      [branchB, 'CN B'],
    ]) {
      await prisma.location.create({
        data: { id, tenantId, name, type: 'BRANCH' },
      });
      await prisma.branch.create({ data: { id, tenantId, locationId: id } });
    }
    await prisma.location.create({
      data: { id: warehouseId, tenantId, name: 'Kho tổng', type: 'WAREHOUSE' },
    });
    await prisma.product.create({
      data: { id: productId, tenantId, name: 'Nội thất' },
    });
    for (const [id, name] of [
      [cabinetId, 'Tủ'],
      [tableId, 'Bàn'],
    ]) {
      await prisma.productItem.create({
        data: {
          id,
          tenantId,
          productId,
          productName: name,
          productCode: `RD-${id}`,
          retailPrice: 500_000,
          costPrice: 100_000,
        },
      });
    }
    await prisma.customer.create({
      data: {
        id: customerId,
        tenantId,
        name: 'Trần Thị Khách',
        phone: '0911222333',
      },
    });
    await prisma.inventory.create({
      data: {
        tenantId,
        locationId: warehouseId,
        productItemId: cabinetId,
        stock: 3,
        lockedStock: 2,
      },
    });

    // Thứ tự tạo = thứ tự createdAt tăng dần.
    await createOrder('URGENT', {
      status: OrderStatus.CONFIRMED,
      priority: OrderPriority.URGENT,
      depositAmount: 300_000,
      depositPercent: 30,
      requestedDeliveryDate: '2026-10-10',
      lines: [{ productItemId: cabinetId, quantity: 1, custom: true }],
    });
    await createOrder('HIGH', {
      status: OrderStatus.CONFIRMED,
      priority: OrderPriority.HIGH,
      requestedDeliveryDate: '2026-10-08',
      lines: [{ productItemId: cabinetId, quantity: 3 }],
    });
    await createOrder('OUT', {
      status: OrderStatus.CONFIRMED,
      lines: [{ productItemId: tableId, quantity: 1 }],
    });
    await createOrder('PACKED', {
      status: OrderStatus.PACKED,
      lines: [{ productItemId: cabinetId, quantity: 2 }],
    });
    await createOrder('CASH', {
      status: OrderStatus.RECEIVED,
      grandTotal: 500_000,
      shippedAt: new Date(Date.UTC(2026, 9, 3)),
      lines: [
        {
          productItemId: tableId,
          quantity: 1,
          status: OrderItemStatus.SHIPPED,
        },
      ],
    });
    await createOrder('POS', {
      status: OrderStatus.COMPLETED,
      fulfillmentType: FulfillmentType.TAKEAWAY,
      lines: [
        {
          productItemId: tableId,
          quantity: 1,
          status: OrderItemStatus.SHIPPED,
        },
      ],
    });
    await createOrder('OTHER-BRANCH', {
      status: OrderStatus.CONFIRMED,
      branchId: branchB,
      lines: [{ productItemId: cabinetId, quantity: 1 }],
    });

    await prisma.payment.create({
      data: {
        tenantId,
        orderId: ids.CASH,
        method: 'CASH',
        kind: 'BALANCE',
        amount: 500_000,
        status: 'PAID',
        paidAt: new Date(Date.UTC(2026, 9, 3, 2)),
        collectedById: shipperId,
        remittanceStatus: RemittanceStatus.PENDING,
      },
    });
    const urgentLine = await prisma.orderItem.findFirstOrThrow({
      where: { orderId: ids.URGENT },
    });
    await prisma.orderItemCustomization.create({
      data: {
        tenantId,
        orderItemId: urgentLine.id,
        lengthCm: 181,
        material: 'Gỗ sồi',
        attachmentUrls: [],
        specs: {
          create: [
            { name: 'Ngăn kéo', value: '3', position: 2 },
            { name: 'Tay nắm', value: 'Đồng', position: 1 },
          ],
        },
      },
    });
  });

  afterAll(async () => {
    await prisma.payment.deleteMany({ where: { tenantId } });
    await prisma.orderItemCustomization.deleteMany({ where: { tenantId } });
    await prisma.orderItem.deleteMany({ where: { order: { tenantId } } });
    await prisma.order.deleteMany({ where: { tenantId } });
    await prisma.inventory.deleteMany({ where: { tenantId } });
    await prisma.customer.deleteMany({ where: { tenantId } });
    await prisma.productItem.deleteMany({ where: { tenantId } });
    await prisma.product.deleteMany({ where: { tenantId } });
    await prisma.branch.deleteMany({ where: { tenantId } });
    await prisma.location.deleteMany({ where: { tenantId } });
    await prisma.user.deleteMany({ where: { tenantId } });
    await prisma.tenant.delete({ where: { id: tenantId } });
    await prisma.$disconnect();
  });

  describe('list', () => {
    it('lists newest first by default, every branch for the owner', async () => {
      const result = await reads.findAll(owner, tenantId, query());
      expect(codesOf(result)).toEqual(
        ['OTHER-BRANCH', 'POS', 'CASH', 'PACKED', 'OUT', 'HIGH', 'URGENT'].map(
          (n) => `${P}-${n}`,
        ),
      );
      expect(result.pagination).toEqual({
        total: 7,
        page: 1,
        limit: 50,
        totalPages: 1,
      });
    });

    it('sorts by priority most urgent first, not alphabetically', async () => {
      const result = await reads.findAll(
        owner,
        tenantId,
        query({ sort: 'priority' }),
      );
      expect(codesOf(result).slice(0, 3)).toEqual([
        `${P}-URGENT`,
        `${P}-HIGH`,
        `${P}-OTHER-BRANCH`, // NORMAL mới nhất
      ]);
    });

    it('cuts a priority-sorted page across the buckets', async () => {
      const page2 = await reads.findAll(
        owner,
        tenantId,
        query({ sort: 'priority', page: 2, limit: 3 }),
      );
      // Trang 1 = URGENT, HIGH, OTHER-BRANCH; trang 2 là ba đơn NORMAL kế tiếp.
      expect(codesOf(page2)).toEqual([`${P}-POS`, `${P}-CASH`, `${P}-PACKED`]);
      expect(page2.pagination.total).toBe(7);
    });

    it('sorts by requested delivery date, soonest first, undated last', async () => {
      const result = await reads.findAll(
        owner,
        tenantId,
        query({ sort: 'requestedDeliveryDate' }),
      );
      expect(codesOf(result).slice(0, 3)).toEqual([
        `${P}-HIGH`,
        `${P}-URGENT`,
        `${P}-OTHER-BRANCH`,
      ]);
    });

    it('filters by stockSummary against on-shelf stock', async () => {
      const enough = await reads.findAll(
        owner,
        tenantId,
        query({ stockSummary: 'ENOUGH' }),
      );
      // URGENT cần 1, trên kệ 1; PACKED đã khoá hàng của chính nó; OTHER-BRANCH cũng cần 1 –
      // chưa đóng gói thì không đơn nào giữ hàng của đơn nào.
      expect(codesOf(enough).sort()).toEqual(
        [`${P}-OTHER-BRANCH`, `${P}-PACKED`, `${P}-URGENT`].sort(),
      );
      expect(enough.pagination.total).toBe(3);

      const partial = await reads.findAll(
        owner,
        tenantId,
        query({ stockSummary: 'PARTIAL' }),
      );
      expect(codesOf(partial)).toEqual([`${P}-HIGH`]);

      const out = await reads.findAll(
        owner,
        tenantId,
        query({ stockSummary: 'OUT' }),
      );
      expect(codesOf(out)).toEqual([`${P}-OUT`]);
    });

    it('sorts and pages the stockSummary filter the same way', async () => {
      const result = await reads.findAll(
        owner,
        tenantId,
        query({ stockSummary: 'ENOUGH', sort: 'priority', limit: 2 }),
      );
      expect(codesOf(result)).toEqual([`${P}-URGENT`, `${P}-OTHER-BRANCH`]);
      expect(result.pagination).toMatchObject({ total: 3, totalPages: 2 });
    });

    it('matches nothing on stockSummary once an order has shipped', async () => {
      const result = await reads.findAll(
        owner,
        tenantId,
        query({ stockSummary: 'ENOUGH', status: OrderStatus.RECEIVED }),
      );
      expect(result.data).toEqual([]);
    });

    it('searches the order code as well as the customer', async () => {
      const byCode = await reads.findAll(
        owner,
        tenantId,
        query({ search: `${P}-PACK` }),
      );
      expect(codesOf(byCode)).toEqual([`${P}-PACKED`]);

      const byCustomer = await reads.findAll(
        owner,
        tenantId,
        query({ search: 'thị khách' }),
      );
      expect(byCustomer.pagination.total).toBe(7);
    });

    it('filters by cash still held by a shipper', async () => {
      const pending = await reads.findAll(
        owner,
        tenantId,
        query({ cashRemittanceStatus: RemittanceStatus.PENDING }),
      );
      expect(codesOf(pending)).toEqual([`${P}-CASH`]);

      const none = await reads.findAll(
        owner,
        tenantId,
        query({ cashRemittanceStatus: RemittanceStatus.NOT_APPLICABLE }),
      );
      expect(none.pagination.total).toBe(6);
      expect(codesOf(none)).not.toContain(`${P}-CASH`);
    });

    it('filters by priority, assignee and the contract’s from/to', async () => {
      expect(
        codesOf(
          await reads.findAll(
            owner,
            tenantId,
            query({ priority: OrderPriority.HIGH }),
          ),
        ),
      ).toEqual([`${P}-HIGH`]);
      expect(
        (
          await reads.findAll(
            owner,
            tenantId,
            query({ assigneeId: randomUUID() }),
          )
        ).data,
      ).toEqual([]);
      // createdAt: URGENT 00:00, HIGH 00:01, OUT 00:02.
      expect(
        codesOf(
          await reads.findAll(
            owner,
            tenantId,
            query({
              from: '2026-10-01T00:01:00Z',
              to: '2026-10-01T00:02:00Z',
              fromDate: '2020-01-01T00:00:00Z', // `from` thắng
            }),
          ),
        ),
      ).toEqual([`${P}-OUT`, `${P}-HIGH`]);
    });

    it('keeps a staff account to its own branch', async () => {
      const result = await reads.findAll(staffAtA, tenantId, query());
      expect(codesOf(result)).not.toContain(`${P}-OTHER-BRANCH`);
      expect(result.pagination.total).toBe(6);

      await expect(
        reads.findAll(staffAtA, tenantId, query({ branchId: branchB })),
      ).rejects.toMatchObject({
        response: { code: ErrorCode.SCOPE_FILTER_DENIED },
      });
    });

    it('answers the OrderListItem shape and keeps what POS reads', async () => {
      const result = await reads.findAll(
        owner,
        tenantId,
        query({ search: `${P}-URGENT` }),
      );
      const [order] = result.data;
      expect(order).toMatchObject({
        code: `${P}-URGENT`,
        priority: OrderPriority.URGENT,
        branch: { id: branchA, name: 'CN A' },
        customer: { name: 'Trần Thị Khách', phone: '0911222333' },
        assignee: {
          id: assigneeId,
          name: 'Lan Nguyễn',
          phoneNumber: `rd-${assigneeId}`,
        },
        createdBy: { id: ownerId, name: 'Chủ' },
        grandTotal: 1_000_000,
        subtotal: 1_000_000,
        deposit: { amount: 300_000, percent: 30 },
        amountDue: 700_000,
        collection: null,
        requestedDeliveryDate: '2026-10-10',
        itemCount: 1,
        stockSummary: 'ENOUGH',
      });
      // POS (src/types/order.ts) đọc các field này trên cùng route.
      expect(order.user).toMatchObject({ id: ownerId });
      expect(order.items[0]).toMatchObject({
        productName: 'Tủ',
        quantity: 1,
        unitPrice: 500_000,
        discountAmount: 0,
        lineTotal: 500_000,
        stockCheck: { status: 'ENOUGH', stock: 1, shortQuantity: 0 },
      });
      expect(order).not.toHaveProperty('payments');
      expect(order).not.toHaveProperty('channelPayload');
    });
  });

  describe('detail', () => {
    it('answers OrderDetail with each line’s stockCheck, location and custom specs', async () => {
      const order = await reads.findOne(owner, tenantId, ids.URGENT);
      expect(order.items).toHaveLength(1);
      expect(order.items[0]).toMatchObject({
        isCustom: true,
        sourceLocation: { id: warehouseId, name: 'Kho tổng' },
        stockCheck: { status: 'ENOUGH', stock: 1, shortQuantity: 0 },
        customization: {
          lengthCm: 181,
          material: 'Gỗ sồi',
          // Theo `position`, không theo thứ tự ghi.
          specs: [
            { name: 'Tay nắm', value: 'Đồng', unit: null },
            { name: 'Ngăn kéo', value: '3', unit: null },
          ],
        },
      });
      expect(order.shipments).toEqual([]);
      expect(order.returns).toEqual([]);
    });

    it('shows how much of a line is missing', async () => {
      const order = await reads.findOne(owner, tenantId, ids.HIGH);
      expect(order.items[0].stockCheck).toEqual({
        status: 'PARTIAL',
        stock: 1,
        shortQuantity: 2,
      });
    });

    it('reads the cash a shipper still holds as the collection, and no stockCheck once shipped', async () => {
      const order = await reads.findOne(owner, tenantId, ids.CASH);
      expect(order).toMatchObject({
        amountDue: 500_000,
        collection: {
          method: 'CASH',
          amount: 500_000,
          collectedBy: { id: shipperId, name: `rd-${shipperId}` },
          cashRemittanceStatus: RemittanceStatus.PENDING,
          remittanceConfirmedBy: null,
        },
      });
      expect(order.items[0].stockCheck).toBeNull();
    });

    it('does not find another tenant’s order', async () => {
      const otherTenantUser = {
        ...owner,
        tenantId: randomUUID(),
      } as unknown as AuthUser;
      await expect(
        reads.findOne(otherTenantUser, otherTenantUser.tenantId!, ids.URGENT),
      ).rejects.toMatchObject({
        response: { code: ErrorCode.ORDER_NOT_FOUND },
      });
    });

    it('refuses a staff account another branch’s order', async () => {
      await expect(
        reads.findOne(staffAtA, tenantId, ids['OTHER-BRANCH']),
      ).rejects.toMatchObject({
        response: { code: ErrorCode.ORDER_BRANCH_DENIED },
      });
    });
  });
});
