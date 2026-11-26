import { SetMetadata } from '@nestjs/common';

export const RAW_RESPONSE_KEY = 'rawResponse';

/** Bỏ bọc envelope cho route, dùng cho webhook và probe. */
export const RawResponse = () => SetMetadata(RAW_RESPONSE_KEY, true);
