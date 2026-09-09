import { SetMetadata } from '@nestjs/common';

export const RAW_RESPONSE_KEY = 'rawResponse';

/** Opts a route out of the `{ success, message?, data }` envelope - for bodies somebody else owns, such as a payment webhook or an infrastructure probe. */
export const RawResponse = () => SetMetadata(RAW_RESPONSE_KEY, true);
