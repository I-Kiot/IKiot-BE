import { BadRequestException } from '@nestjs/common';
import { holdsStock } from '../../common/constants/product-status';
import { ErrorCode } from '../../common/errors/error-codes';

/**
 * Refuses a COMBO or SERVICE variant at a door where stock comes in: a stock document's lines
 * (import, transfer, stocktake) and `POST /inventory`. A combo is stocked through its components -
 * stock booked on the combo itself would never be sold (orders expand it) and would count in every
 * stock total. Checked at those doors rather than in `openLot`, which runs per line inside receipts
 * and would cost a query each time.
 */
export function assertHoldsStock(
  items: { id: string; sku: string | null; itemType: string }[],
): void {
  const refused = items.filter((item) => !holdsStock(item.itemType));
  if (refused.length === 0) return;
  throw new BadRequestException({
    code: ErrorCode.PRODUCT_ITEM_NOT_STOCKABLE,
    message: `Only a product holds stock; not: ${refused
      .map((item) => `${item.sku ?? item.id} (${item.itemType})`)
      .join(', ')}`,
  });
}
