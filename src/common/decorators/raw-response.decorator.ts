import { SetMetadata } from '@nestjs/common';

export const RAW_RESPONSE_KEY = 'rawResponse';

/** Bỏ route khỏi envelope `{ success, message?, data }` - dành cho body do bên khác quyết định, như webhook thanh toán hay probe hạ tầng. */
export const RawResponse = () => SetMetadata(RAW_RESPONSE_KEY, true);
