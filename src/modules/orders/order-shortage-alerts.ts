import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  ProductionListService,
  type StockPair,
} from '../production-requests/production-list.service';
import { STOCKED_LINE_TYPES } from '../../common/constants/order-status';

/** Trạng thái trước khi ghi đơn: các cặp (kho, SKU) sắp bị chạm và mỗi cặp đang thiếu bao nhiêu. */
export interface ShortageSnapshot {
  pairs: StockPair[];
  before: Map<string, number> | null;
}

interface PairLine {
  productItemId: string;
  sourceLocationId?: string | null;
  lineType?: string | null;
}

export function stockPairsOf(lines: readonly PairLine[]): StockPair[] {
  const seen = new Map<string, StockPair>();
  for (const line of lines) {
    if (line.lineType && !STOCKED_LINE_TYPES.includes(line.lineType)) continue;
    const locationId = line.sourceLocationId ?? null;
    seen.set(`${locationId ?? '-'}|${line.productItemId}`, {
      locationId,
      productItemId: line.productItemId,
    });
  }
  return [...seen.values()];
}

/** Cảnh báo thiếu hàng phía đơn: chụp trạng thái trước khi ghi, báo người phụ trách kho khi dòng chuyển từ đủ sang thiếu. */
@Injectable()
export class OrderShortageAlerts {
  private readonly logger = new Logger(OrderShortageAlerts.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly productionList: ProductionListService,
  ) {}

  async snapshot(
    tenantId: string,
    lines: readonly PairLine[],
  ): Promise<ShortageSnapshot> {
    const pairs = stockPairsOf(lines);
    if (pairs.length === 0) return { pairs, before: new Map() };
    try {
      return {
        pairs,
        before: await this.productionList.shortagesFor(tenantId, pairs),
      };
    } catch (error) {
      this.logger.warn(`Shortage snapshot failed: ${String(error)}`);
      return { pairs, before: null };
    }
  }

  /** Sau commit: so mọi cặp đơn đã chạm (trước và sau) với snapshot. */
  async notify(
    tenantId: string,
    orderId: string,
    snapshot: ShortageSnapshot,
    actorId: string,
  ): Promise<void> {
    if (!snapshot.before) return;
    try {
      const lines = await this.prisma.orderItem.findMany({
        where: { orderId },
        select: { productItemId: true, sourceLocationId: true, lineType: true },
      });
      const pairs = stockPairsOf([
        ...snapshot.pairs.map((pair) => ({
          productItemId: pair.productItemId,
          sourceLocationId: pair.locationId,
        })),
        ...lines,
      ]);
      if (pairs.length === 0) return;
      await this.productionList.notifyNewShortages(
        tenantId,
        pairs,
        snapshot.before,
        actorId,
      );
    } catch (error) {
      this.logger.warn(`Shortage alert failed: ${String(error)}`);
    }
  }
}
