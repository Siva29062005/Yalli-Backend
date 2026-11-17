import { SetMetadata } from '@nestjs/common';

export const RESPONSE_MESSAGE_KEY = 'response:message';
export const SKIP_ENVELOPE_KEY = 'response:skip-envelope';

/** Overrides the default success message in the response envelope. */
export const ResponseMessage = (message: string) =>
  SetMetadata(RESPONSE_MESSAGE_KEY, message);

/** Opt-out for infrastructure endpoints (health probes) that must keep their own shape. */
export const SkipEnvelope = () => SetMetadata(SKIP_ENVELOPE_KEY, true);
