import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  ProductionListService,
  type StockPair,
} from '../production-requests/production-list.service';
import { STOCKED_LINE_TYPES } from '../../common/constants/order-status';

/** What an order write looked like before it ran: the (location, SKU) pairs it was about to touch and how short each was. */
export interface ShortageSnapshot {
  pairs: StockPair[];
  before: Map<string, number> | null;
}

/** A line as far as the shortage alert needs it. */
interface PairLine {
  productItemId: string;
  sourceLocationId?: string | null;
  lineType?: string | null;
}

/** The (location, SKU) pairs of the lines that hold stock, once each. */
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

/**
 * The order side of the shortage alert (B-3, contract §3): a manual create, an edit of the lines or a
 * line made custom can tip a (location, SKU) row of the production list from enough to short, and the
 * people looking after that location are told once, when it tips - not on every order after. The
 * list and the message are `ProductionListService`'s; this only takes the "before" snapshot ahead of
 * the write and hands it back after the commit, re-reading the order's lines so a line that moved to
 * a custom SKU inside the transaction is compared too. A side-channel: it never fails the order.
 */
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

  /** After the commit: every pair the order touched, before or after, compared with the snapshot. */
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
