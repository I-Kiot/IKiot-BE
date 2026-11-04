import { DiscoveryService } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AppModule } from './../src/app.module';
import { AuditTemplate } from './../src/common/audit/audit-descriptor';
import { SubscriptionAuditTemplate } from './../src/modules/subscriptions/subscription.audit-template';
import { SubscriptionBillingService } from './../src/modules/subscriptions/subscription-billing.service';
import { BranchService } from './../src/modules/branches/branches.service';
import { WarehouseService } from './../src/modules/warehouses/warehouses.service';
import { ProductService } from './../src/modules/products/products.service';
import { InventoryService } from './../src/modules/inventories/inventories.service';
import { StockMovementService } from './../src/modules/stock-movement-requests/stock-movement-requests.service';
import { UserService } from './../src/modules/users/users.service';

// Biên dịch toàn bộ đồ thị DI mà không gọi init(), không cần database. Bắt lỗi nối dây mà type-check không thấy: provider chưa export từ module, thiếu DiscoveryModule, hoặc service được inject nhưng chưa đăng ký.
describe('AppModule DI graph', () => {
  it('resolves every rewired provider', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    // Không resolve được APP_* theo token từ testing module đã compile, nên wiring của interceptor được kiểm ở test discovery bên dưới.
    expect(
      moduleRef.get(SubscriptionBillingService, { strict: false }),
    ).toBeDefined();
    expect(moduleRef.get(BranchService, { strict: false })).toBeDefined();
    expect(moduleRef.get(WarehouseService, { strict: false })).toBeDefined();
    expect(moduleRef.get(ProductService, { strict: false })).toBeDefined();
    expect(moduleRef.get(InventoryService, { strict: false })).toBeDefined();
    expect(
      moduleRef.get(StockMovementService, { strict: false }),
    ).toBeDefined();
    expect(moduleRef.get(UserService, { strict: false })).toBeDefined();
  });

  // Mục đích của @AuditTemplate(): module nghiệp vụ tự đăng ký descriptor, AppModule không cần liệt kê. Nếu discovery trả rỗng, audit sẽ âm thầm rơi về mô tả chung thay vì báo lỗi.
  it('discovers every @AuditTemplate() descriptor', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    const discovered = moduleRef
      .get(DiscoveryService, { strict: false })
      .getProviders({ metadataKey: AuditTemplate.KEY })
      .map((wrapper): unknown => wrapper.instance);

    expect(
      discovered.some(
        (instance) => instance instanceof SubscriptionAuditTemplate,
      ),
    ).toBe(true);
  });
});
