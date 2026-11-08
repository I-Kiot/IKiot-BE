import 'dotenv/config';
import { randomUUID } from 'crypto';
import { Test } from '@nestjs/testing';
import { PrismaModule } from './../src/prisma/prisma.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { InvoiceReadService } from './../src/modules/invoices/invoices-read.service';
import { OrderReadService } from './../src/modules/orders/order-read.service';
import { QueryInvoiceDto } from './../src/modules/invoices/dto/query-invoice.dto';
import { QueryOrderJourneyDto } from './../src/modules/orders/dto/query-order-journey.dto';
import { SystemRole } from './../src/common/constants/system-role';
import type { AuthUser } from './../src/common/types/auth-user.type';

/**
 * Tìm hoá đơn và đơn theo SĐT khách trên Postgres thật: số lưu chỉ còn chữ số (`0912345678`) nên gõ có dấu cách, dấu chấm hay `+84` vẫn phải ra đúng khách. Tự tạo một tenant riêng và dọn sạch.
 */
describe('Search by customer phone – invoices and orders', () => {
  let prisma: PrismaService;
  let invoices: InvoiceReadService;
  let orders: OrderReadService;

  const tenantId = randomUUID();
  const ownerId = randomUUID();
  const branchId = randomUUID();
  const customerId = randomUUID();
  const otherCustomerId = randomUUID();
  const P = `IS${tenantId.slice(0, 6)}`;

  const owner: AuthUser = {
    userId: ownerId,
    tenantId,
    systemRole: SystemRole.TENANT_OWNER,
    roleId: null,
    branchId: null,
    warehouseId: null,
    permissions: new Set(),
    shiftSupervision: null,
    email: null,
    displayName: null,
    phoneNumber: '0900000000',
  };

  const invoiceQuery = (search: string) =>
    Object.assign(new QueryInvoiceDto(), { page: 1, limit: 50, search });
  const orderQuery = (search: string) =>
    Object.assign(new QueryOrderJourneyDto(), { page: 1, limit: 50, search });

  async function addOrder(code: string, customer: string, total: number) {
    const orderId = randomUUID();
    await prisma.order.create({
      data: {
        id: orderId,
        code: `${P}-${code}`,
        tenantId,
        branchId,
        customerId: customer,
        userId: ownerId,
        assigneeId: ownerId,
        status: 'COMPLETED',
        grandTotal: total,
        subtotal: total,
      },
    });
    await prisma.invoice.create({
      data: {
        tenantId,
        orderId,
        invoiceNumber: `${P}-HD-${code}`,
        status: 'ISSUED',
        subtotal: total,
        total,
      },
    });
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule],
      providers: [InvoiceReadService, OrderReadService],
    }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    invoices = moduleRef.get(InvoiceReadService);
    orders = moduleRef.get(OrderReadService);

    await prisma.tenant.create({ data: { id: tenantId, name: 'search-e2e' } });
    await prisma.user.create({
      data: {
        id: ownerId,
        tenantId,
        phoneNumber: `is-${ownerId}`,
        systemRole: SystemRole.TENANT_OWNER,
      },
    });
    await prisma.location.create({
      data: { id: branchId, tenantId, name: 'CN A', type: 'BRANCH' },
    });
    await prisma.branch.create({
      data: { id: branchId, tenantId, locationId: branchId },
    });
    await prisma.customer.create({
      data: {
        id: customerId,
        tenantId,
        name: 'Trần Thị Khách',
        phone: '0912345678',
      },
    });
    await prisma.customer.create({
      data: {
        id: otherCustomerId,
        tenantId,
        name: 'Lê Văn Khác',
        phone: '0988777666',
      },
    });
    await addOrder('A', customerId, 1_000_000);
    await addOrder('B', customerId, 2_000_000);
    await addOrder('C', otherCustomerId, 3_000_000);
  });

  afterAll(async () => {
    await prisma.invoice.deleteMany({ where: { tenantId } });
    await prisma.order.deleteMany({ where: { tenantId } });
    await prisma.customer.deleteMany({ where: { tenantId } });
    await prisma.branch.deleteMany({ where: { tenantId } });
    await prisma.location.deleteMany({ where: { tenantId } });
    await prisma.user.deleteMany({ where: { tenantId } });
    await prisma.tenant.deleteMany({ where: { id: tenantId } });
    await prisma.$disconnect();
  });

  const invoiceNumbers = async (search: string) =>
    (await invoices.findAll(owner, tenantId, invoiceQuery(search))).data
      .map((row) => row.invoiceNumber)
      .sort();
  const orderCodes = async (search: string) =>
    (await orders.findAll(owner, tenantId, orderQuery(search))).data
      .map((row) => row.code)
      .sort();

  const customerInvoices = [`${P}-HD-A`, `${P}-HD-B`];
  const customerOrders = [`${P}-A`, `${P}-B`];

  it.each([
    '0912345678',
    '091 234 5678',
    '091.234.5678',
    '+84 912 345 678',
    '84912345678',
    '0912',
    '345678',
  ])(
    'finds the invoices of the customer by phone typed as %s',
    async (term) => {
      expect(await invoiceNumbers(term)).toEqual(customerInvoices);
    },
  );

  it.each(['0912345678', '091 234 5678', '+84912345678', '0912'])(
    'finds the orders of the customer by phone typed as %s',
    async (term) => {
      expect(await orderCodes(term)).toEqual(customerOrders);
    },
  );

  it('still finds by customer name, order code and invoice number', async () => {
    expect(await invoiceNumbers('trần thị')).toEqual(customerInvoices);
    expect(await invoiceNumbers(`${P}-HD-C`)).toEqual([`${P}-HD-C`]);
    expect(await invoiceNumbers(`${P}-C`)).toEqual([`${P}-HD-C`]);
    expect(await orderCodes('lê văn')).toEqual([`${P}-C`]);
  });

  it('returns nothing for a phone that no customer has', async () => {
    expect(await invoiceNumbers('0999 000 111')).toEqual([]);
    expect(await orderCodes('0999 000 111')).toEqual([]);
  });
});
