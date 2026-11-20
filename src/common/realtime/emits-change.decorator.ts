import { SetMetadata } from '@nestjs/common';
import type { ChangeSpec } from './change-feed.types';

export const EMITS_CHANGE_KEY = 'emitsChange';

/**
 * Đánh dấu một handler POST / PUT / PATCH / DELETE là "làm đổi dữ liệu mà màn hình khác đang xem". `ChangeFeedInterceptor` phát `entity:changed` sau khi handler thành công.
 * Spec nằm ở file `*.change-template.ts` của domain; không có danh sách trung tâm, và `change-feed.coverage.spec.ts` fail nếu một route ghi của các controller hành trình thiếu decorator này.
 */
export const EmitsChange = (spec: ChangeSpec) =>
  SetMetadata(EMITS_CHANGE_KEY, spec);
