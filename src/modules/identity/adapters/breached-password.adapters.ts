import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { BreachedPasswordChecker } from '../ports/ports.js';

@Injectable()
export class DisabledBreachedPasswordChecker extends BreachedPasswordChecker {
  isBreached(): Promise<boolean> {
    return Promise.resolve(false);
  }
}

/**
 * Have I Been Pwned "range" API (k-anonymity): only the first 5 hex chars of the SHA-1 leave our network;
 * the full password / hash is never transmitted. Fails OPEN on outage (a breach-API outage must not block sign-ups),
 * but logs a warning so it is visible.
 */
@Injectable()
export class HibpBreachedPasswordChecker extends BreachedPasswordChecker {
  private readonly logger = new Logger(HibpBreachedPasswordChecker.name);

  async isBreached(password: string): Promise<boolean> {
    const sha1 = createHash('sha1')
      .update(password)
      .digest('hex')
      .toUpperCase();
    const prefix = sha1.slice(0, 5);
    const suffix = sha1.slice(5);
    try {
      const res = await fetch(
        `https://api.pwnedpasswords.com/range/${prefix}`,
        {
          headers: { 'Add-Padding': 'true', 'User-Agent': 'yalli-backend' },
          signal: AbortSignal.timeout(3_000),
        },
      );
      if (!res.ok) throw new Error(`status ${res.status}`);
      return (await res.text()).split('\n').some((line) => {
        const [hash, count] = line.trim().split(':');
        return hash === suffix && Number(count) > 0;
      });
    } catch (err) {
      this.logger.warn(
        { err: (err as Error).message },
        'Breached-password lookup unavailable (failing open)',
      );
      return false;
    }
  }
}
