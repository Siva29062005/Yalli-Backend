import { randomBytes, randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { generateSync } from 'otplib';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { configureApp } from '../../src/app.setup.js';
import { InMemoryEphemeralStore } from '../../src/infrastructure/cache/in-memory-ephemeral-store.js';
import { EphemeralStore } from '../../src/infrastructure/cache/ephemeral-store.js';
import { RedisService } from '../../src/infrastructure/cache/redis.service.js';
import { PrismaService } from '../../src/infrastructure/database/prisma.service.js';
import { SeedService } from '../../src/modules/access/seed.service.js';
import { CommerceWorker } from '../../src/modules/orders/commerce-worker.js';
import { InMemoryBus } from '../../src/modules/outbox/in-memory-bus.js';
import { MessageBus } from '../../src/modules/outbox/message-bus.js';
import { OutboxRelay } from '../../src/modules/outbox/outbox-relay.js';
import { RazorpayHttp } from '../../src/modules/payments/razorpay.adapter.js';
import { FakeRazorpayApi } from './fake-razorpay.js';
import { InMemoryNotificationAdapter } from '../../src/modules/identity/adapters/in-memory-notification.adapter.js';
import { PasswordService } from '../../src/modules/identity/crypto/password.service.js';
import {
  BreachedPasswordChecker,
  NotificationPort,
} from '../../src/modules/identity/ports/ports.js';

export const STRONG_PASSWORD = 'Tr0ub4dor&3-horse-staple';

class FakeBreachedChecker extends BreachedPasswordChecker {
  readonly breached = new Set(['Breached-Password-2024!']);
  isBreached(password: string): Promise<boolean> {
    return Promise.resolve(this.breached.has(password));
  }
}

export interface TestContext {
  app: NestExpressApplication;
  prisma: PrismaService;
  store: InMemoryEphemeralStore;
  notifier: InMemoryNotificationAdapter;
  passwords: PasswordService;
  razorpay: FakeRazorpayApi;
  bus: InMemoryBus;
  relay: OutboxRelay;
  /** Publishes EVERY pending outbox event (the relay sends bounded batches). */
  drainOutbox: () => Promise<number>;
  worker: CommerceWorker;
  http: () => ReturnType<typeof request>;
  close: () => Promise<void>;
}

export async function createTestApp(): Promise<TestContext> {
  const store = new InMemoryEphemeralStore();
  const notifier = new InMemoryNotificationAdapter();
  const razorpay = new FakeRazorpayApi();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(RedisService)
    .useValue({
      client: {},
      ping: () => Promise.resolve(),
      onModuleDestroy: () => undefined,
    })
    .overrideProvider(EphemeralStore)
    .useValue(store)
    .overrideProvider(NotificationPort)
    .useValue(notifier)
    .overrideProvider(RazorpayHttp)
    .useValue(razorpay)
    .overrideProvider(BreachedPasswordChecker)
    .useValue(new FakeBreachedChecker())
    .compile();

  const app = moduleRef.createNestApplication<NestExpressApplication>({
    rawBody: true,
  });
  configureApp(app);
  await app.init();
  await app.get(SeedService).syncRolesAndPermissions();
  await app.get(SeedService).ensureDefaultWarehouse();

  return {
    app,
    prisma: app.get(PrismaService),
    store,
    notifier,
    passwords: app.get(PasswordService),
    razorpay,
    bus: app.get(MessageBus) as InMemoryBus,
    relay: app.get(OutboxRelay),
    drainOutbox: async () => {
      const relay = app.get(OutboxRelay);
      let total = 0;
      for (let i = 0; i < 100; i++) {
        const n = await relay.tick();
        if (n === 0) break;
        total += n;
      }
      return total;
    },
    worker: app.get(CommerceWorker),
    http: () => request(app.getHttpServer()),
    close: () => app.close(),
  };
}

export const uniqueEmail = (prefix = 'user'): string =>
  `${prefix}.${randomBytes(6).toString('hex')}@example.com`;
/** A fresh client IP per call, so tests do not share per-IP rate-limit buckets. */
export const freshIp = (): string =>
  `10.${randomBytes(1)[0]}.${randomBytes(1)[0]}.${(randomBytes(1)[0]! % 250) + 1}`;
export const uniquePhone = (): string =>
  `+9198${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`.replace(
    /^(\+9198)0/,
    '$16',
  );

/** TOTP code for the time-step `offset` away from now. Each step can be redeemed once (replay protection). */
export const totp = (secret: string, offset = 0): string =>
  generateSync({ secret, epoch: Math.floor(Date.now() / 1000) + offset * 30 });

export interface Session {
  email: string;
  password: string;
  ip: string;
  accessToken: string;
  refreshToken: string;
  userId: string;
}

/** Drives the real HTTP API: register -> verify email -> login. */
export class Scenario {
  constructor(readonly ctx: TestContext) {}

  async registerUser(
    overrides: Partial<{
      email: string;
      password: string;
      phone: string;
      ip: string;
    }> = {},
  ) {
    const email = overrides.email ?? uniqueEmail();
    const password = overrides.password ?? STRONG_PASSWORD;
    const ip = overrides.ip ?? freshIp();
    const res = await this.ctx
      .http()
      .post('/api/v1/auth/register')
      .set('X-Forwarded-For', ip)
      .send({
        firstName: 'Asha',
        lastName: 'Kumar',
        email,
        phone: overrides.phone ?? uniquePhone(),
        password,
        newsletter: false,
        acceptPrivacyPolicy: true,
      });
    return { res, email, password, ip };
  }

  async verifiedUser(
    overrides: Partial<{ email: string; password: string; ip: string }> = {},
  ) {
    const { res, email, password, ip } = await this.registerUser(overrides);
    if (res.status !== 202)
      throw new Error(
        `register failed: ${res.status} ${JSON.stringify(res.body)}`,
      );
    const msg = this.ctx.notifier.last('EMAIL_VERIFICATION', email);
    if (!msg) throw new Error('no verification email captured');
    const v = await this.ctx
      .http()
      .post('/api/v1/auth/verify-email')
      .set('X-Forwarded-For', ip)
      .send({ token: msg.token });
    if (v.status !== 200)
      throw new Error(`verify failed: ${v.status} ${JSON.stringify(v.body)}`);
    return { email, password, ip };
  }

  async login(
    email: string,
    password: string,
    ip = freshIp(),
    headers: Record<string, string> = {},
  ) {
    return this.ctx
      .http()
      .post('/api/v1/auth/login')
      .set('X-Forwarded-For', ip)
      .set(headers)
      .send({ email, password });
  }

  async session(
    overrides: Partial<{ email: string; password: string; ip: string }> = {},
  ): Promise<Session> {
    const { email, password, ip } = await this.verifiedUser(overrides);
    const res = await this.login(email, password, ip);
    if (res.status !== 200 || !res.body.data.accessToken)
      throw new Error(
        `login failed: ${res.status} ${JSON.stringify(res.body)}`,
      );
    const me = await this.ctx
      .http()
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${res.body.data.accessToken}`);
    return {
      email,
      password,
      ip,
      accessToken: res.body.data.accessToken,
      refreshToken: res.body.data.refreshToken,
      userId: me.body.data.id,
    };
  }

  /** Gives a user a role directly in the database (test setup only; production uses the audited admin API). */
  async grantRole(userId: string, roleName: string): Promise<void> {
    const role = await this.ctx.prisma.role.findUniqueOrThrow({
      where: { name: roleName },
    });
    await this.ctx.prisma.userRole.upsert({
      where: { userId_roleId: { userId, roleId: role.id } },
      update: {},
      create: { userId, roleId: role.id },
    });
    await this.ctx.app
      .get(
        await import('../../src/modules/access/authorization.service.js').then(
          (m) => m.AuthorizationService,
        ),
      )
      .invalidate(userId);
  }

  /** Enrols TOTP via the API. Uses time-step -1 for confirmation so steps 0 and +1 remain for login/step-up. */
  async enableMfa(
    s: Session,
  ): Promise<{ secret: string; recoveryCodes: string[] }> {
    // The caller will spend steps -1, 0 and +1 relative to "now". The server accepts +/-1 step, so all three must be
    // used inside ONE 30 s step. Near a step boundary (under parallel load) wait for the next step to start.
    await waitForFreshTotpStep();
    const enroll = await this.ctx
      .http()
      .post('/api/v1/auth/mfa/enroll')
      .set('Authorization', `Bearer ${s.accessToken}`)
      .set('X-Forwarded-For', s.ip)
      .send({ password: s.password });
    if (enroll.status !== 200)
      throw new Error(
        `enroll failed: ${enroll.status} ${JSON.stringify(enroll.body)}`,
      );
    const secret = enroll.body.data.secret as string;
    const confirm = await this.ctx
      .http()
      .post('/api/v1/auth/mfa/confirm')
      .set('Authorization', `Bearer ${s.accessToken}`)
      .set('X-Forwarded-For', s.ip)
      .send({ code: totp(secret, -1) });
    if (confirm.status !== 200)
      throw new Error(
        `confirm failed: ${confirm.status} ${JSON.stringify(confirm.body)}`,
      );
    return {
      secret,
      recoveryCodes: confirm.body.data.recoveryCodes as string[],
    };
  }

  /** A staff user with the given role who has MFA enabled and a fresh step-up token (spends TOTP steps 0 and +1). */
  async staff(
    roleName: string,
  ): Promise<Session & { secret: string; stepUpToken: string }> {
    const s = await this.session();
    await this.grantRole(s.userId, roleName);
    const { secret } = await this.enableMfa(s);
    const login = await this.login(s.email, s.password, s.ip);
    if (login.body.data.mfaRequired !== true)
      throw new Error('expected MFA challenge');
    const verified = await this.ctx
      .http()
      .post('/api/v1/auth/mfa/verify')
      .set('X-Forwarded-For', s.ip)
      .send({ mfaToken: login.body.data.mfaToken, code: totp(secret, 0) });
    if (verified.status !== 200)
      throw new Error(
        `mfa verify failed: ${verified.status} ${JSON.stringify(verified.body)}`,
      );
    return {
      ...s,
      secret,
      accessToken: verified.body.data.accessToken,
      refreshToken: verified.body.data.refreshToken,
      stepUpToken: verified.body.data.accessToken,
    };
  }
}

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
export const newRequestId = (): string => randomUUID();

export const authed = (s: { accessToken: string; ip: string }) => ({
  Authorization: `Bearer ${s.accessToken}`,
  'X-Forwarded-For': s.ip,
});

/** Decodes a JWT payload WITHOUT verifying it (tests inspect claims only). */
export const jwtPayload = (token: string): Record<string, unknown> =>
  JSON.parse(
    Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8'),
  ) as Record<string, unknown>;

export async function waitFor<T>(
  fn: () => T | undefined | Promise<T | undefined>,
  timeoutMs = 3_000,
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Fast fixtures written straight to the database (tests of PUBLIC behaviour; admin flows go through the API). */
export class CatalogFixture {
  constructor(private readonly ctx: TestContext) {}

  async category(
    name = `Cat ${randomBytes(3).toString('hex')}`,
    parentId: string | null = null,
  ) {
    const slug =
      `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${randomBytes(3).toString('hex')}`.replace(
        /^-+|-+$/g,
        '',
      );
    return this.ctx.prisma.category.create({ data: { name, slug, parentId } });
  }

  async brand(name = `Brand ${randomBytes(3).toString('hex')}`) {
    return this.ctx.prisma.brand.create({
      data: { name, slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-') },
    });
  }

  /** A PUBLISHED product with one variant and `stock` units on hand in the default warehouse. */
  async product(
    opts: {
      name?: string;
      priceMinor?: number;
      salePriceMinor?: number | null;
      stock?: number;
      categoryIds?: string[];
      brandId?: string | null;
      status?: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
      summary?: string;
      tags?: string[];
      gstRateBps?: number;
    } = {},
  ) {
    const name = opts.name ?? `Product ${randomBytes(4).toString('hex')}`;
    const suffix = randomBytes(4).toString('hex');
    const warehouse = await this.ctx.prisma.warehouse.findFirstOrThrow({
      where: { isDefault: true },
    });
    const product = await this.ctx.prisma.product.create({
      data: {
        slug: `${name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '')}-${suffix}`,
        name,
        summary: opts.summary ?? null,
        status: opts.status ?? 'PUBLISHED',
        publishedAt: new Date(),
        brandId: opts.brandId ?? null,
        gstRateBps: opts.gstRateBps ?? 1800,
        categories: {
          create: (opts.categoryIds ?? []).map((categoryId) => ({
            categoryId,
          })),
        },
        tags: {
          create: (opts.tags ?? []).map((t) => ({
            tag: {
              connectOrCreate: { where: { name: t }, create: { name: t } },
            },
          })),
        },
        variants: {
          create: [
            {
              sku: `SKU-${suffix}`.toUpperCase(),
              priceMinor: opts.priceMinor ?? 59_000,
              salePriceMinor: opts.salePriceMinor ?? null,
            },
          ],
        },
      },
      include: { variants: true },
    });
    const variant = product.variants[0]!;
    await this.ctx.prisma.inventory.create({
      data: {
        variantId: variant.id,
        warehouseId: warehouse.id,
        onHand: opts.stock ?? 10,
      },
    });
    return { product, variant };
  }
}

/** Ensures at least `budgetSeconds` remain in the current 30 s TOTP step (waits for the next step otherwise). */
export async function waitForFreshTotpStep(budgetSeconds = 12): Promise<void> {
  const into = (Date.now() / 1000) % 30;
  if (30 - into < budgetSeconds)
    await new Promise((r) => setTimeout(r, (30 - into + 0.25) * 1000));
}

/** Drives the storefront flows end to end through the real HTTP API. */
export class Shop {
  readonly fx: CatalogFixture;
  constructor(
    readonly ctx: TestContext,
    readonly s: Scenario,
  ) {
    this.fx = new CatalogFixture(ctx);
  }

  /** A signed-in customer with one saved address (state selectable for the GST split). */
  async customer(
    state = 'Tamil Nadu',
  ): Promise<Session & { addressId: string }> {
    const u = await this.s.session();
    const res = await this.ctx
      .http()
      .post('/api/v1/me/addresses')
      .set(authed(u))
      .send({
        fullName: 'Asha Kumar',
        phone: '98765 43210',
        line1: 'Building No 3, Darga Complex',
        city: 'Madurai',
        state,
        postalCode: '625002',
      });
    if (res.status !== 201)
      throw new Error(
        `address failed: ${res.status} ${JSON.stringify(res.body)}`,
      );
    return { ...u, addressId: res.body.data.id as string };
  }

  async fill(u: Session, items: { variantId: string; quantity?: number }[]) {
    for (const i of items) {
      const r = await this.ctx
        .http()
        .post('/api/v1/cart/items')
        .set(authed(u))
        .send({ variantId: i.variantId, quantity: i.quantity ?? 1 });
      if (r.status !== 201)
        throw new Error(
          `cart add failed: ${r.status} ${JSON.stringify(r.body)}`,
        );
    }
  }

  place(
    u: Session & { addressId: string },
    body: Record<string, unknown> = {},
    key: string = `k-${randomUUID()}`,
  ) {
    return this.ctx
      .http()
      .post('/api/v1/checkout/orders')
      .set({ ...authed(u), 'Idempotency-Key': key })
      .send({ addressId: u.addressId, ...body });
  }

  /** Cart -> order. Returns the order view. */
  async order(
    u: Session & { addressId: string },
    items: { variantId: string; quantity?: number }[],
    body: Record<string, unknown> = {},
  ) {
    await this.fill(u, items);
    const res = await this.place(u, body);
    if (res.status !== 201)
      throw new Error(
        `place failed: ${res.status} ${JSON.stringify(res.body)}`,
      );
    return res.body.data as {
      id: string;
      orderNumber: string;
      status: string;
      totals: { totalMinor: number };
    };
  }

  initiate(u: Session, orderId: string, key: string = `p-${randomUUID()}`) {
    return this.ctx
      .http()
      .post(`/api/v1/orders/${orderId}/payments`)
      .set({ ...authed(u), 'Idempotency-Key': key })
      .send({});
  }

  async startPayment(u: Session, orderId: string) {
    const res = await this.initiate(u, orderId);
    if (res.status !== 200)
      throw new Error(
        `initiate failed: ${res.status} ${JSON.stringify(res.body)}`,
      );
    return res.body.data as {
      paymentId: string;
      providerOrderId: string;
      amountMinor: number;
      keyId: string;
    };
  }

  /** POSTs a provider webhook exactly as Razorpay would: raw body bytes + signature headers. */
  webhook(w: { raw: string; headers: Record<string, string> }) {
    return this.ctx
      .http()
      .post('/api/v1/webhooks/razorpay')
      .set(w.headers)
      .send(w.raw);
  }

  /** The customer pays at the provider and the provider delivers the captured webhook. */
  async paid(u: Session, orderId: string) {
    const init = await this.startPayment(u, orderId);
    const payment = this.ctx.razorpay.pay(init.providerOrderId, 'captured');
    const res = await this.webhook(
      this.ctx.razorpay.paymentWebhook('payment.captured', payment),
    );
    if (res.status !== 200)
      throw new Error(
        `webhook failed: ${res.status} ${JSON.stringify(res.body)}`,
      );
    return { init, payment, webhook: res };
  }

  getOrder(u: Session, orderId: string) {
    return this.ctx.http().get(`/api/v1/orders/${orderId}`).set(authed(u));
  }

  dbOrder(orderId: string) {
    return this.ctx.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: {
        items: true,
        payments: true,
        refunds: true,
        history: { orderBy: { createdAt: 'asc' } },
      },
    });
  }

  stock(variantId: string) {
    return this.ctx.prisma.inventory.findFirstOrThrow({ where: { variantId } });
  }
}
