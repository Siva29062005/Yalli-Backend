export const REQUEST_ID_HEADER = 'x-request-id';
export const API_PREFIX = 'api';
export const API_DEFAULT_VERSION = '1';
/** Routes served outside /api/v1 (infrastructure probes, key discovery, media). */
export const UNPREFIXED_ROUTES = [
  'health/live',
  'health/ready',
  '.well-known/jwks.json',
  'media/:key',
];
