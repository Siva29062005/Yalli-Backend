import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { METHOD_METADATA } from '@nestjs/common/constants.js';
import {
  IS_AUTHENTICATED_KEY,
  IS_PUBLIC_KEY,
  OPTIONAL_AUTH_KEY,
  PERMISSIONS_KEY,
} from '../decorators/access.decorators.js';

/**
 * Deny-by-default made structural: the application REFUSES TO START if any HTTP route lacks an explicit access
 * policy (@Public, @OptionalAuth, @Authenticated or @RequirePermissions). A forgotten decorator can therefore never ship open.
 */
@Injectable()
export class AccessPolicyAuditor implements OnApplicationBootstrap {
  private readonly logger = new Logger(AccessPolicyAuditor.name);

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
    private readonly reflector: Reflector,
  ) {}

  onApplicationBootstrap(): void {
    const unprotected: string[] = [];
    let routes = 0;
    for (const wrapper of this.discovery.getControllers()) {
      const { instance } = wrapper;
      if (!instance || !wrapper.metatype) continue;
      const proto = Object.getPrototypeOf(instance) as object;
      for (const name of this.scanner.getAllMethodNames(proto)) {
        const handler = (proto as Record<string, unknown>)[name] as (
          ...a: unknown[]
        ) => unknown;
        if (Reflect.getMetadata(METHOD_METADATA, handler) === undefined)
          continue; // not a route
        routes++;
        const targets = [handler, wrapper.metatype];
        const hasPolicy =
          this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets) ||
          this.reflector.getAllAndOverride<boolean>(
            IS_AUTHENTICATED_KEY,
            targets,
          ) ||
          this.reflector.getAllAndOverride<boolean>(
            OPTIONAL_AUTH_KEY,
            targets,
          ) ||
          // an EMPTY permission list is not a policy (it would mean "any signed-in user")
          (this.reflector.getAllAndOverride<string[] | undefined>(
            PERMISSIONS_KEY,
            targets,
          )?.length ?? 0) > 0;
        if (!hasPolicy) unprotected.push(`${wrapper.metatype.name}.${name}`);
      }
    }
    if (unprotected.length > 0) {
      throw new Error(
        `Routes without an access policy (refusing to start):\n  - ${unprotected.join('\n  - ')}`,
      );
    }
    this.logger.log(`Access policy verified for ${routes} routes`);
  }
}
