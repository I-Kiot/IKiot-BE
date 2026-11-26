import { BadRequestException } from '@nestjs/common';
import { holdsStock } from '../../common/constants/product-status';
import { ErrorCode } from '../../common/errors/error-codes';

/** Từ chối nhập tồn cho COMBO / SERVICE. */
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
