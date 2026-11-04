import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { InventoryService } from '../inventories/inventories.service';
import { InvoiceService } from '../invoices/invoices.service';
import { OrderService } from './orders.service';
import { assertOrderStepAccess, OrderStepPermission } from './order-handler';
import { assertPickupReady, assertStorePickup } from './order-pickup.rules';
import { FulfillmentStatus } from '../../common/constants/fulfillment-status';
import { ErrorCode } from '../../common/errors/error-codes';
import type { AuthUser } from '../../common/types/auth-user.type';

/**
 * Đơn khách tới lấy (STORE_PICKUP): đóng gói xong thì đơn nằm ở PACKED chờ khách, không có shipment.
 * - `collect`: thu số còn lại tại quầy (tiền mặt ghi luôn, QR chờ webhook SePay).
 * - `handOver`: đã thu đủ thì giao hàng cho khách: trừ tồn, PACKED → COMPLETED, xuất hoá đơn.
 * Bước thu tiền và giao dùng chung quyền với “Bắt đầu vận chuyển” (`OrderStepPermission.SHIP`): chủ shop, người có `orders:ship` tại kho xuất.
 */
@Injectable()
export class OrderPickupService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
    private readonly orders: OrderService,
    private readonly invoices: InvoiceService,
  ) {}

  /** Nạp đơn cùng fulfillment đã đóng gói; chặn đơn không phải khách tới lấy, chưa sẵn sàng, hay người gọi không có quyền. */
  private async loadPickupOrder(user: AuthUser, tenantId: string, id: string) {
    const order = await this.prisma.order.findFirst({
      where: { id, tenantId },
      select: {
        id: true,
        code: true,
        status: true,
        fulfillmentType: true,
        assigneeId: true,
        branchId: true,
        grandTotal: true,
        note: true,
        payments: {
          select: {
            id: true,
            kind: true,
            method: true,
            status: true,
            amount: true,
            paymentReference: true,
          },
        },
        fulfillments: {
          where: { status: FulfillmentStatus.PACKED },
          select: {
            id: true,
            locationId: true,
            items: {
              select: {
                quantity: true,
                orderItemId: true,
                orderItem: {
                  select: { productItemId: true, sku: true, productName: true },
                },
              },
            },
          },
        },
      },
    });
    if (!order) {
      throw new NotFoundException({
        code: ErrorCode.ORDER_NOT_FOUND,
        message: 'Order not found',
      });
    }
    const scope = this.orders.branchScope(user);
    if (scope.branchId !== undefined && order.branchId !== scope.branchId) {
      throw new ForbiddenException({
        code: ErrorCode.ORDER_BRANCH_DENIED,
        message: 'This order does not belong to your branch',
      });
    }
    assertStorePickup(order);
    assertPickupReady(order);
    const [fulfillment] = order.fulfillments;
    assertOrderStepAccess(
      user,
      order,
      OrderStepPermission.SHIP,
      fulfillment?.locationId ?? order.branchId,
    );
    return { order, fulfillment };
  }
}
