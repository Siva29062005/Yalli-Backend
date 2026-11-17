import {
  createParamDecorator,
  SetMetadata,
  type ExecutionContext,
} from '@nestjs/common';
import type { Request } from 'express';
import type { AuthPrincipal } from '../auth/auth-principal.js';

export const IS_PUBLIC_KEY = 'access:public';
export const IS_AUTHENTICATED_KEY = 'access:authenticated';
export const OPTIONAL_AUTH_KEY = 'access:optional-auth';
export const PERMISSIONS_KEY = 'access:permissions';
export const STEP_UP_KEY = 'access:step-up';

/** Explicitly open route. Everything else is DENIED unless it declares a policy. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/**
 * Guest OR authenticated (e.g. the cart). No token => guest. A token that IS sent must be valid (invalid => 401):
 * a bad token never silently downgrades to guest access.
 */
export const OptionalAuth = () => SetMetadata(OPTIONAL_AUTH_KEY, true);

/** Any authenticated user. Handlers MUST scope data to `principal.userId` (ownership), never to a client-supplied id. */
export const Authenticated = () => SetMetadata(IS_AUTHENTICATED_KEY, true);

/** Requires ALL listed permissions (resolved server-side, never from the token). */
export const RequirePermissions = (...permissions: string[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);

/** Requires an MFA-verified token whose last (re-)authentication is recent. */
export const RequireStepUp = (maxAgeSeconds = 600) =>
  SetMetadata(STEP_UP_KEY, { maxAgeSeconds });

/** Injects the authenticated principal (routes marked @Public have none). */
export const CurrentPrincipal = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): AuthPrincipal => {
    const principal = ctx.switchToHttp().getRequest<Request>().auth;
    if (!principal)
      throw new Error(
        'CurrentPrincipal used on a route without authentication',
      );
    return principal;
  },
);
