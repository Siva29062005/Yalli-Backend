export const ErrorCode = {
  BadRequest: 'BAD_REQUEST',
  ValidationFailed: 'VALIDATION_FAILED',
  Unauthorized: 'UNAUTHORIZED',
  /** The access token is missing, expired, invalid or its session ended: the ONLY 401 a client should answer with a
   *  silent refresh. Any other 401 (wrong password or code) is about the request and must not be retried. */
  AccessTokenInvalid: 'ACCESS_TOKEN_INVALID',
  /** The sign-in 2FA challenge is unknown, expired, used up or out of attempts: start again from the password. */
  MfaChallengeExpired: 'MFA_CHALLENGE_EXPIRED',
  Forbidden: 'FORBIDDEN',
  StepUpRequired: 'STEP_UP_REQUIRED',
  EmailNotVerified: 'EMAIL_NOT_VERIFIED',
  AccountSuspended: 'ACCOUNT_SUSPENDED',
  MfaRequired: 'MFA_REQUIRED',
  NotFound: 'NOT_FOUND',
  Conflict: 'CONFLICT',
  PayloadTooLarge: 'PAYLOAD_TOO_LARGE',
  UnsupportedMediaType: 'UNSUPPORTED_MEDIA_TYPE',
  TooManyRequests: 'TOO_MANY_REQUESTS',
  ServiceUnavailable: 'SERVICE_UNAVAILABLE',
  Internal: 'INTERNAL_ERROR',
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export const STATUS_TO_CODE: Readonly<Record<number, ErrorCode>> = {
  400: ErrorCode.BadRequest,
  401: ErrorCode.Unauthorized,
  403: ErrorCode.Forbidden,
  404: ErrorCode.NotFound,
  409: ErrorCode.Conflict,
  413: ErrorCode.PayloadTooLarge,
  415: ErrorCode.UnsupportedMediaType,
  429: ErrorCode.TooManyRequests,
  503: ErrorCode.ServiceUnavailable,
};
