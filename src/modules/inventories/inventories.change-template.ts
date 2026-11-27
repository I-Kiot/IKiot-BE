import {
  ChangeAction,
  ChangeResource,
} from '../../common/constants/change-feed';
import type {
  ChangeExtractContext,
  ChangeSpec,
  ChangeTarget,
} from '../../common/realtime/change-feed.types';
import {
  readChild,
  readRef,
  readString,
} from '../../common/realtime/change-ref';

/** Nội dung feed `entity:changed` của hàng hỏng. */

/** Đọc dòng tồn từ body. */
export function inventoryTarget({
  body,
  params,
}: ChangeExtractContext): ChangeTarget {
  const id = params.id ?? readRef(body)?.id ?? null;
  const item = readChild(body, 'productItem');
  return {
    subjectId: id,
    code: readString(item, 'sku') ?? readString(item, 'productName'),
  };
}

const damagedSpec = (action: ChangeAction, verb: string): ChangeSpec => ({
  action,
  subject: ChangeResource.INVENTORIES,
  extract: inventoryTarget,
  summary: ({ actor, code }) =>
    `${actor} vừa ${verb} ${code ? `hàng ${code}` : 'một mặt hàng'}`,
});

export const InventoryChanges = {
  markedDamaged: damagedSpec(
    ChangeAction.INVENTORY_MARKED_DAMAGED,
    'đánh dấu hỏng',
  ),
  repaired: damagedSpec(ChangeAction.INVENTORY_DAMAGED_REPAIRED, 'sửa xong'),
  writtenOff: damagedSpec(
    ChangeAction.INVENTORY_DAMAGED_WRITTEN_OFF,
    'huỷ hàng hỏng',
  ),
} satisfies Record<string, ChangeSpec>;
