import {
  Injectable,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  randomUUID,
  createPrivateKey,
  createPublicKey,
  type KeyObject,
} from 'node:crypto';
import { SignJWT, jwtVerify, exportJWK, type JWK } from 'jose';
import type { Env } from '../../../config/env.js';

export interface AccessClaims {
  userId: string;
  sessionId: string;
  amr: string[];
  authTime: number;
}

const TOKEN_TYPE = 'at+jwt';

/**
 * Issues and verifies short-lived access tokens (EdDSA / Ed25519).
 * Claims are minimal and contain NO roles, permissions or personal data: authorization is resolved server-side.
 * Rotation: set a new JWT_KEY_ID/JWT_PRIVATE_KEY_B64 and move the old public key into JWT_RETIRED_PUBLIC_KEYS_JSON
 * until the longest-lived access token (JWT_ACCESS_TTL_SECONDS) has expired.
 */
@Injectable()
export class AccessTokenService implements OnModuleInit {
  private signingKey!: KeyObject;
  private kid!: string;
  private readonly verifyKeys = new Map<string, KeyObject>();
  private issuer!: string;
  private audience!: string;
  private ttl!: number;

  constructor(private readonly config: ConfigService<Env, true>) {}

  onModuleInit(): void {
    this.kid = this.config.get('JWT_KEY_ID', { infer: true });
    this.issuer = this.config.get('JWT_ISSUER', { infer: true });
    this.audience = this.config.get('JWT_AUDIENCE', { infer: true });
    this.ttl = this.config.get('JWT_ACCESS_TTL_SECONDS', { infer: true });

    const pem = Buffer.from(
      this.config.get('JWT_PRIVATE_KEY_B64', { infer: true }),
      'base64',
    ).toString('utf8');
    this.signingKey = createPrivateKey(pem);
    if (this.signingKey.asymmetricKeyType !== 'ed25519')
      throw new Error('JWT_PRIVATE_KEY_B64 must be an Ed25519 private key');
    this.verifyKeys.set(this.kid, createPublicKey(this.signingKey));

    const retired = JSON.parse(
      this.config.get('JWT_RETIRED_PUBLIC_KEYS_JSON', { infer: true }),
    ) as Record<string, string>;
    for (const [kid, b64] of Object.entries(retired)) {
      const key = createPublicKey(Buffer.from(b64, 'base64').toString('utf8'));
      if (key.asymmetricKeyType !== 'ed25519')
        throw new Error(`Retired key ${kid} must be Ed25519`);
      this.verifyKeys.set(kid, key);
    }
  }

  get ttlSeconds(): number {
    return this.ttl;
  }

  async sign(claims: AccessClaims): Promise<string> {
    return new SignJWT({
      sid: claims.sessionId,
      amr: claims.amr,
      auth_time: claims.authTime,
    })
      .setProtectedHeader({ alg: 'EdDSA', kid: this.kid, typ: TOKEN_TYPE })
      .setIssuer(this.issuer)
      .setAudience(this.audience)
      .setSubject(claims.userId)
      .setJti(randomUUID())
      .setIssuedAt()
      .setExpirationTime(`${this.ttl}s`)
      .sign(this.signingKey);
  }

  /** Any failure (bad signature, wrong alg/kid/aud/iss/typ, expired, malformed claims) is a uniform 401. */
  async verify(token: string): Promise<AccessClaims> {
    try {
      const { payload } = await jwtVerify(
        token,
        (header) => {
          const key = header.kid ? this.verifyKeys.get(header.kid) : undefined;
          if (!key) throw new Error('unknown kid');
          return Promise.resolve(key);
        },
        {
          issuer: this.issuer,
          audience: this.audience,
          algorithms: ['EdDSA'],
          typ: TOKEN_TYPE,
          clockTolerance: 5,
        },
      );
      const {
        sub,
        sid,
        amr,
        auth_time: authTime,
      } = payload as Record<string, unknown>;
      if (
        typeof sub !== 'string' ||
        typeof sid !== 'string' ||
        typeof authTime !== 'number'
      )
        throw new Error('bad claims');
      if (!Array.isArray(amr) || !amr.every((a) => typeof a === 'string'))
        throw new Error('bad amr');
      return { userId: sub, sessionId: sid, amr: amr as string[], authTime };
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }

  async jwks(): Promise<{ keys: JWK[] }> {
    const keys: JWK[] = [];
    for (const [kid, key] of this.verifyKeys)
      keys.push({ ...(await exportJWK(key)), kid, alg: 'EdDSA', use: 'sig' });
    return { keys };
  }
}
