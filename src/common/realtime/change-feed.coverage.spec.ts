import { METHOD_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import {
  OrderController,
  SepayOrderWebhookController,
} from '../../modules/orders/orders.controller';
import { ShipmentController } from '../../modules/shipments/shipments.controller';
import {
  ProductionRequestController,
  ProductionListController,
} from '../../modules/production-requests/production-requests.controller';
import {
  ProductionDeliveryController,
  WorkshopController,
} from '../../modules/production-requests/production-deliveries.controller';
import { StockMovementController } from '../../modules/stock-movement-requests/stock-movement-requests.controller';
import { OrderReturnController } from '../../modules/order-returns/order-returns.controller';
import { EMITS_CHANGE_KEY } from './emits-change.decorator';

type Controller = { name: string; prototype: object };

const CONTROLLERS: readonly Controller[] = [
  OrderController,
  SepayOrderWebhookController,
  ShipmentController,
  ProductionRequestController,
  ProductionListController,
  WorkshopController,
  ProductionDeliveryController,
  StockMovementController,
  OrderReturnController,
];

const WRITES = new Set<RequestMethod>([
  RequestMethod.POST,
  RequestMethod.PUT,
  RequestMethod.PATCH,
  RequestMethod.DELETE,
]);

/** Route ghi cố ý không phát feed, kèm lý do. */
const ALLOWLIST: Readonly<Record<string, string>> = {
  'OrderController.createPosQr':
    'phát mã QR không phải một sự kiện (CLAUDE.md gốc, "Order action trail"); tiền về mới là sự kiện (ORDER_QR_PAID, phát từ webhook)',
  'SepayOrderWebhookController.handle':
    'webhook @Public không có user; nó phát tường minh qua ChangeFeedService / publishChange',
};

describe('change feed coverage', () => {
  it('every write route of the journey controllers carries @EmitsChange', () => {
    const missing: string[] = [];
    for (const controller of CONTROLLERS) {
      const proto = controller.prototype;
      for (const name of Object.getOwnPropertyNames(proto)) {
        if (name === 'constructor') continue;
        const handler = (proto as Record<string, unknown>)[name];
        if (typeof handler !== 'function') continue;
        const method = Reflect.getMetadata(METHOD_METADATA, handler) as
          RequestMethod | undefined;
        if (method === undefined || !WRITES.has(method)) continue;
        const key = `${controller.name}.${name}`;
        if (key in ALLOWLIST) continue;
        if (!Reflect.getMetadata(EMITS_CHANGE_KEY, handler)) missing.push(key);
      }
    }
    expect(missing).toEqual([]);
  });

  it('every allowlisted route really exists and is a write route', () => {
    for (const key of Object.keys(ALLOWLIST)) {
      const [cls, name] = key.split('.');
      const controller = CONTROLLERS.find((c) => c.name === cls);
      const handler = (controller?.prototype as Record<string, unknown>)?.[
        name
      ];
      expect(typeof handler).toBe('function');
      expect(
        WRITES.has(
          Reflect.getMetadata(
            METHOD_METADATA,
            handler as object,
          ) as RequestMethod,
        ),
      ).toBe(true);
    }
  });
});
