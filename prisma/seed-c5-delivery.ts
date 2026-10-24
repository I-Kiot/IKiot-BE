// Dữ liệu thử luồng giao xong & thu tiền (C-5 / C-7) – dev only.
//
// Chạy SAU chuỗi seed của tài liệu test (docs/tai-khoan-test-hanh-trinh.md):
//
//   npx prisma db seed
//   npx tsx prisma/seed-account-role.ts
//   npx tsx prisma/seed-furniture-test.ts
//   npx tsx prisma/seed-c5-delivery.ts
//
// Trong shop "Nội thất Demo" (chủ shop 0981189856):
//   1. Liên kết tài khoản ngân hàng (số giả) để mã QR hiện ra, và đặt webhook key `test-key-local`
//      để tự bắn webhook SePay giả – chỉ ghi khi các cột đó đang trống.
//   2. Tạo 5 đơn đã ở bước "Đang vận chuyển" từ CN Hà Nội, giao nội bộ, shipper là CHỦ SHOP – mở
//      "Đơn giao của tôi" là thấy ngay. Mỗi đơn một kịch bản (xem SCENARIOS).
//
// Đơn được tạo đúng hình dạng luồng thật để lại ở bước đó (dòng hàng SHIPPED, fulfillment HANDED_OVER,
// shipment IN_TRANSIT kèm nhật trình, hoá đơn PENDING), nhưng KHÔNG đụng tồn kho: bước giao xong không
// đọc / ghi tồn. Vì vậy các đơn này không dùng để thử đóng gói hay ship – dùng C6-TEST cho hai bước đó.
//
// Chạy lại an toàn: đơn trùng mã thì bỏ qua.
import 'dotenv/config';
import { PrismaClient } from '../generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  FulfillmentType,
  OrderChannel,
  OrderItemStatus,
  OrderPaymentStatus,
  OrderPriority,
  OrderStatus,
} from '../src/common/constants/order-status';
import { FulfillmentStatus } from '../src/common/constants/fulfillment-status';
import {
  CarrierType,
  ShipmentEventSource,
  ShipmentStatus,
} from '../src/common/constants/shipment-status';
import {
  PaymentKind,
  PaymentMethod,
  PaymentRecordStatus,
} from '../src/common/constants/payment-method';
import { InvoiceService } from '../src/modules/invoices/invoices.service';
import type { PrismaService } from '../src/prisma/prisma.service';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });
// ensurePending chỉ dùng transaction client được truyền vào - không cần Nest.
const invoices = new InvoiceService(prisma as unknown as PrismaService);

const OWNER_PHONE = '0981189856';
const BRANCH_NAME = 'CN Hà Nội';
const CUSTOMER_NAME = 'Khách test giao hàng (C-5)';
/** Bàn làm việc Oak 120×60, giá bán 3.000.000đ - một dòng × 1 cái, nên tổng đơn = giá này. */
const SKU = 'BAN-OAK-120';
const GRAND_TOTAL = 3_000_000;

/** Tài khoản ngân hàng giả: ảnh VietQR vẫn hiện vì dịch vụ chỉ dựng ảnh, không kiểm tra tài khoản có thật. */
const TEST_BANKING = {
  bankingBankName: 'MB',
  bankingAccountNumber: '0123456789',
  bankingAccountName: 'NOI THAT DEMO',
};
const TEST_WEBHOOK_KEY = 'test-key-local';

/** Mỗi đơn một kịch bản; `note` ghi cách thử. Tổng 3.000.000đ. */
const SCENARIOS: { code: string; deposit: number; note: string }[] = [
  {
    code: 'C5-QR-01',
    deposit: 900_000,
    note: 'QR 2.100.000đ → bắn webhook đủ tiền → Hoàn thành',
  },
  {
    code: 'C5-QR-02',
    deposit: 900_000,
    note: 'QR → "Khách không chuyển - thu tiền mặt"',
  },
  {
    code: 'C5-QR-03',
    deposit: 900_000,
    note: 'QR → bắn webhook chuyển thiếu (vd. 1.000.000đ) → đơn vẫn chờ',
  },
  {
    code: 'C5-CASH-01',
    deposit: 900_000,
    note: 'Tiền mặt 2.100.000đ → Đã nhận hàng, chờ chủ xác nhận nhận tiền (A-10)',
  },
  {
    code: 'C5-NONE-01',
    deposit: GRAND_TOTAL,
    note: 'Đã cọc đủ → bấm Đã giao là Hoàn thành',
  },
];

async function main() {
  const owner = await prisma.user.findFirst({
    where: { phoneNumber: OWNER_PHONE, systemRole: 'TENANT_OWNER' },
    include: { tenant: true },
  });
  if (!owner?.tenant) {
    throw new Error(`Chưa có chủ shop ${OWNER_PHONE} - chạy seed-account-role.ts trước.`);
  }
  const tenant = owner.tenant;
  const tenantId = tenant.id;

  // 1. Tài khoản ngân hàng + webhook key – chỉ khi đang trống, để không đè cấu hình đã tự đặt.
  if (!tenant.bankingAccountNumber || !tenant.bankingBankName) {
    await prisma.tenant.update({ where: { id: tenantId }, data: TEST_BANKING });
    console.log(`Ngân hàng: liên kết ${TEST_BANKING.bankingBankName} ${TEST_BANKING.bankingAccountNumber}.`);
  } else {
    console.log(`Ngân hàng: đã có (${tenant.bankingBankName} ${tenant.bankingAccountNumber}) - giữ nguyên.`);
  }
  if (!tenant.bankingSepayWebhookApiKey) {
    await prisma.tenant.update({
      where: { id: tenantId },
      data: { bankingSepayWebhookApiKey: TEST_WEBHOOK_KEY },
    });
    console.log(`Webhook key: đặt "${TEST_WEBHOOK_KEY}".`);
  } else {
    console.log('Webhook key: đã có - giữ nguyên (dùng key đó khi bắn webhook giả).');
  }

  const [branch, item] = await Promise.all([
    prisma.location.findFirst({ where: { tenantId, name: BRANCH_NAME } }),
    prisma.productItem.findFirst({
      where: { tenantId, sku: SKU },
      select: { id: true, sku: true, productName: true },
    }),
  ]);
  if (!branch) throw new Error(`Chưa có "${BRANCH_NAME}" - chạy seed-account-role.ts trước.`);
  if (!item) throw new Error(`Chưa có SKU ${SKU} - chạy seed-furniture-test.ts trước.`);

  const customer =
    (await prisma.customer.findFirst({ where: { tenantId, name: CUSTOMER_NAME } })) ??
    (await prisma.customer.create({ data: { tenantId, name: CUSTOMER_NAME } }));

  // 2. Các đơn đã ở "Đang vận chuyển".
  for (const scenario of SCENARIOS) {
    if (await prisma.order.findFirst({ where: { tenantId, code: scenario.code } })) {
      console.log(`${scenario.code}: đã có - bỏ qua.`);
      continue;
    }
    await createShippingOrder({
      tenantId,
      ownerId: owner.id,
      branchId: branch.id, // Branch.id = Location.id
      // CN Hà Nội vừa bán vừa xuất hàng (tài liệu test, phần 0: chưa đặt được kho giao mặc định).
      warehouseId: branch.id,
      customerId: customer.id,
      item,
      scenario,
    });
    console.log(`${scenario.code}: tạo - ${scenario.note}`);
  }
}

/** Một đơn đúng hình dạng luồng thật để lại sau bước "Chuyển Đang vận chuyển". */
async function createShippingOrder(input: {
  tenantId: string;
  ownerId: string;
  branchId: string;
  warehouseId: string;
  customerId: string;
  item: { id: string; sku: string | null; productName: string | null };
  scenario: { code: string; deposit: number; note: string };
}) {
  const { tenantId, ownerId, scenario } = input;
  const depositCoversAll = scenario.deposit >= GRAND_TOTAL;
  const now = new Date();

  await prisma.$transaction(async (tx) => {
    // Đơn: đã xác nhận, đã ship; chủ shop vừa tạo vừa phụ trách.
    const order = await tx.order.create({
      data: {
        tenantId,
        branchId: input.branchId,
        customerId: input.customerId,
        code: scenario.code,
        status: OrderStatus.SHIPPING,
        priority: OrderPriority.NORMAL,
        channel: OrderChannel.MANUAL,
        fulfillmentType: FulfillmentType.HOME_DELIVERY,
        userId: ownerId,
        assigneeId: ownerId,
        confirmedById: ownerId,
        confirmedAt: now,
        shippedById: ownerId,
        shippedAt: now,
        subtotal: GRAND_TOTAL,
        grandTotal: GRAND_TOTAL,
        depositAmount: scenario.deposit,
        paymentStatus: depositCoversAll
          ? OrderPaymentStatus.PAID
          : OrderPaymentStatus.PARTIALLY_PAID,
        recipientName: 'Anh Nam (test)',
        recipientPhone: '0912345678',
        deliveryAddress: '1 Cầu Giấy, Hà Nội',
        note: scenario.note,
        items: {
          create: {
            productItemId: input.item.id,
            productName: input.item.productName,
            sku: input.item.sku,
            quantity: 1,
            listUnitPrice: GRAND_TOTAL,
            unitPrice: GRAND_TOTAL,
            lineTotal: GRAND_TOTAL,
            sourceLocationId: input.warehouseId,
            status: OrderItemStatus.SHIPPED,
          },
        },
      },
      select: { id: true, items: { select: { id: true } } },
    });

    // Mọi đơn có đúng một hoá đơn SALE từ lúc tạo; đơn chưa COMPLETED thì hoá đơn còn PENDING.
    await invoices.ensurePending(tx, order.id);

    // Khoản cọc đã thu, như A-2 ghi lúc tạo đơn.
    await tx.payment.create({
      data: {
        tenantId,
        orderId: order.id,
        kind: PaymentKind.DEPOSIT,
        method: PaymentMethod.CASH,
        amount: scenario.deposit,
        status: PaymentRecordStatus.PAID,
        paidAt: now,
        locationId: input.branchId,
        collectedById: ownerId,
        createdById: ownerId,
      },
    });

    // Phiếu đóng hàng đã bàn giao ở kho tổng.
    const fulfillment = await tx.fulfillment.create({
      data: {
        tenantId,
        orderId: order.id,
        locationId: input.warehouseId,
        status: FulfillmentStatus.HANDED_OVER,
        assigneeId: ownerId,
        verifiedById: ownerId,
        verifiedAt: now,
        packedAt: now,
        handedOverAt: now,
        items: {
          create: {
            orderItemId: order.items[0].id,
            quantity: 1,
            qtyPicked: 1,
            qtyPacked: 1,
          },
        },
      },
      select: { id: true },
    });

    // Lần giao nội bộ đang trên đường, shipper là chủ shop.
    await tx.shipment.create({
      data: {
        tenantId,
        orderId: order.id,
        fulfillmentId: fulfillment.id,
        carrierType: CarrierType.INTERNAL,
        driverId: ownerId,
        status: ShipmentStatus.IN_TRANSIT,
        recipientName: 'Anh Nam (test)',
        recipientPhone: '0912345678',
        deliveryAddress: '1 Cầu Giấy, Hà Nội',
        note: scenario.note,
        events: {
          create: [
            {
              status: ShipmentStatus.PICKED_UP,
              source: ShipmentEventSource.MANUAL,
              createdById: ownerId,
              occurredAt: now,
            },
            {
              status: ShipmentStatus.IN_TRANSIT,
              source: ShipmentEventSource.MANUAL,
              createdById: ownerId,
              occurredAt: new Date(now.getTime() + 1000),
            },
          ],
        },
      },
    });
  });
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
