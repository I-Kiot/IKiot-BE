import { SetMetadata } from '@nestjs/common';
import type { ChangeSpec } from './change-feed.types';

export const EMITS_CHANGE_KEY = 'emitsChange';

/** Đánh dấu route ghi để phát `entity:changed` sau khi thành công. */
export const EmitsChange = (spec: ChangeSpec) =>
  SetMetadata(EMITS_CHANGE_KEY, spec);
