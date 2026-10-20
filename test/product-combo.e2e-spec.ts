import 'dotenv/config';
import { randomUUID } from 'crypto';
import { Test } from '@nestjs/testing';
import { PrismaModule } from './../src/prisma/prisma.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { ProductService } from './../src/modules/products/products.service';
import { SubscriptionService } from './../src/modules/subscriptions/subscriptions.service';
import { ErrorCode } from './../src/common/errors/error-codes';
import {
  ProductItemType,
  ProductStatus,
} from './../src/common/constants/product-status';

/**
 * Khai báo combo trong danh mục (2026-10-20) trên Postgres thật (docker compose up -d): tạo combo,
 * combo lồng combo, sửa thành phần, và các lỗi chặn (vòng lặp, khác tenant, xoá / ngừng món đang nằm
 * trong combo). Tự tạo tenant riêng và dọn sạch, chạy lại bao nhiêu lần cũng được.
 */
describe('ProductService – combo components', () => {
  let prisma: PrismaService;
  let products: ProductService;

  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  const tableProductId = randomUUID();
  const chairProductId = randomUUID();
  const foreignProductId = randomUUID();
  const tableId = randomUUID();
  const chairId = randomUUID();
  const foreignItemId = randomUUID();

  const codeOf = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (error) {
      return (error as { getResponse(): { code: string } }).getResponse().code;
    }
    return undefined;
  };

  const createCombo = (
    name: string,
    comboComponents: { componentItemId: string; quantity: number }[],
  ) =>
    products.create(tenantId, {
      name,
      items: [
        {
          productName: name,
          retailPrice: 1_000_000,
          costPrice: 0,
          itemType: ProductItemType.COMBO,
          comboComponents,
        },
      ],
    });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule],
      providers: [
        ProductService,
        {
          provide: SubscriptionService,
          useValue: {
            assertQuota: async () => {},
            requireActiveSubscription: async () => {},
          },
        },
      ],
    }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    products = moduleRef.get(ProductService);

    await prisma.tenant.createMany({
      data: [
        { id: tenantId, name: 'product-combo-e2e' },
        { id: otherTenantId, name: 'product-combo-e2e-other' },
      ],
    });
    await prisma.product.createMany({
      data: [
        { id: tableProductId, tenantId, name: 'Bàn ăn' },
        { id: chairProductId, tenantId, name: 'Ghế ăn' },
        { id: foreignProductId, tenantId: otherTenantId, name: 'Ghế lạ' },
      ],
    });
    const sku = (id: string) => `PC-${id.slice(0, 8)}`;
    await prisma.productItem.createMany({
      data: [
        {
          id: tableId,
          tenantId,
          productId: tableProductId,
          productName: 'Bàn ăn',
          productCode: sku(tableId),
          sku: sku(tableId),
          retailPrice: 2_000_000,
          costPrice: 0,
        },
        {
          id: chairId,
          tenantId,
          productId: chairProductId,
          productName: 'Ghế ăn',
          productCode: sku(chairId),
          sku: sku(chairId),
          retailPrice: 500_000,
          costPrice: 0,
        },
        {
          id: foreignItemId,
          tenantId: otherTenantId,
          productId: foreignProductId,
          productName: 'Ghế lạ',
          productCode: sku(foreignItemId),
          sku: sku(foreignItemId),
          retailPrice: 1,
          costPrice: 0,
        },
      ],
    });
  });

  afterAll(async () => {
    const tenants = { in: [tenantId, otherTenantId] };
    await prisma.comboComponent.deleteMany({
      where: { comboItem: { tenantId: tenants } },
    });
    await prisma.productItemDetail.deleteMany({
      where: { productItem: { tenantId: tenants } },
    });
    await prisma.productItem.deleteMany({ where: { tenantId: tenants } });
    await prisma.productAttribute.deleteMany({ where: { tenantId: tenants } });
    await prisma.product.deleteMany({ where: { tenantId: tenants } });
    await prisma.tenant.deleteMany({ where: { id: tenants } });
    await prisma.$disconnect();
  });

  let diningSetId: string;
  let roomSetId: string;

  it('creates a combo and returns its components', async () => {
    const product = await createCombo('Bộ bàn ăn', [
      { componentItemId: tableId, quantity: 1 },
      { componentItemId: chairId, quantity: 4 },
    ]);
    const [combo] = product.items;
    diningSetId = combo.id;
    expect(combo.itemType).toBe(ProductItemType.COMBO);
    expect(
      combo.comboComponents.map((c) => [c.componentItem.id, c.quantity]).sort(),
    ).toEqual(
      [
        [chairId, 4],
        [tableId, 1],
      ].sort(),
    );
    expect(combo.comboComponents[0].componentItem.retailPrice).toEqual(
      expect.any(Number),
    );
    // Không có ảnh nào thì null, không phải undefined - FE vẽ ô trống.
    expect(combo.comboComponents[0].componentItem.thumbnailUrl).toBeNull();
  });

  it('gives each component a thumbnail, falling back to the product image', async () => {
    await prisma.productImage.create({
      data: {
        productId: chairProductId,
        url: 'https://example.test/chair.png',
        isThumbnail: true,
      },
    });
    const picker = await products.listItems(tenantId, {
      search: 'Ghế ăn',
      limit: 5,
    });
    expect(picker.find((row) => row.id === chairId)?.thumbnailUrl).toBe(
      'https://example.test/chair.png',
    );
  });

  it('creates a combo of a combo', async () => {
    const product = await createCombo('Phòng ăn', [
      { componentItemId: diningSetId, quantity: 1 },
      { componentItemId: chairId, quantity: 2 },
    ]);
    roomSetId = product.items[0].id;
    expect(product.items[0].comboComponents).toHaveLength(2);
  });

  it('refuses a cycle and leaves the combo as it was', async () => {
    expect(
      await codeOf(
        products.updateItem(tenantId, diningSetId, {
          comboComponents: [{ componentItemId: roomSetId, quantity: 1 }],
        }),
      ),
    ).toBe(ErrorCode.PRODUCT_COMBO_INVALID);
    expect(
      await prisma.comboComponent.count({
        where: { comboItemId: diningSetId },
      }),
    ).toBe(2);
  });

  it('refuses a combo with no components, a duplicate or itself', async () => {
    expect(await codeOf(createCombo('Rỗng', []))).toBe(
      ErrorCode.PRODUCT_COMBO_INVALID,
    );
    expect(
      await codeOf(
        createCombo('Trùng', [
          { componentItemId: chairId, quantity: 1 },
          { componentItemId: chairId, quantity: 2 },
        ]),
      ),
    ).toBe(ErrorCode.PRODUCT_COMBO_INVALID);
    expect(
      await codeOf(
        products.updateItem(tenantId, diningSetId, {
          comboComponents: [{ componentItemId: diningSetId, quantity: 1 }],
        }),
      ),
    ).toBe(ErrorCode.PRODUCT_COMBO_INVALID);
  });

  it("refuses another tenant's variant as a component", async () => {
    expect(
      await codeOf(
        createCombo('Lạ', [{ componentItemId: foreignItemId, quantity: 1 }]),
      ),
    ).toBe(ErrorCode.PRODUCT_ITEM_NOT_FOUND);
  });

  it('refuses components on a non-combo variant', async () => {
    expect(
      await codeOf(
        products.updateItem(tenantId, tableId, {
          comboComponents: [{ componentItemId: chairId, quantity: 1 }],
        }),
      ),
    ).toBe(ErrorCode.PRODUCT_COMBO_INVALID);
  });

  it('replaces the components on update', async () => {
    const item = await products.updateItem(tenantId, diningSetId, {
      comboComponents: [
        { componentItemId: tableId, quantity: 1 },
        { componentItemId: chairId, quantity: 6 },
      ],
    });
    expect(
      item.comboComponents.find((c) => c.componentItem.id === chairId)
        ?.quantity,
    ).toBe(6);
  });

  it('refuses deleting or discontinuing a component of a live combo', async () => {
    expect(await codeOf(products.removeItem(tenantId, chairId))).toBe(
      ErrorCode.PRODUCT_ITEM_IN_COMBO,
    );
    expect(await codeOf(products.discontinue(tenantId, chairProductId))).toBe(
      ErrorCode.PRODUCT_ITEM_IN_COMBO,
    );
    expect(
      (await prisma.product.findUnique({ where: { id: chairProductId } }))
        ?.status,
    ).toBe(ProductStatus.ACTIVE);
  });
});
