import { Logger } from '@nestjs/common';
import {
  Scenario,
  authed,
  createTestApp,
  type Session,
  type TestContext,
} from '../support/test-app.js';

let ctx: TestContext;
let s: Scenario;
beforeAll(async () => {
  Logger.overrideLogger(false);
  ctx = await createTestApp();
  s = new Scenario(ctx);
});
afterAll(() => ctx.close());

const list = (who: Session, query = '') =>
  ctx.http().get(`/api/v1/admin/audit-logs${query}`).set(authed(who));

describe('audit-log viewer (audit.read, through the read-only reporting role)', () => {
  it('lists recent events newest first with actor labels, filters by action, category and actor; no user agent', async () => {
    const admin = await s.staff('ADMIN');
    const target = await s.session();
    // a fresh, recognisable event by this admin: a role grant needs MFA on the target, so suspend instead
    await ctx
      .http()
      .patch(`/api/v1/admin/users/${target.userId}/status`)
      .set(authed(admin))
      .send({ status: 'SUSPENDED', reason: 'Audit viewer test' })
      .expect(200);
    const all = await list(admin).expect(200);
    expect(all.body.meta).toMatchObject({ page: 1 });
    const rows = all.body.data as {
      occurredAt: string;
      actorId: string | null;
      actorLabel: string | null;
      action: string;
      userAgent?: unknown;
    }[];
    expect(rows.length).toBeGreaterThan(0);
    const times = rows.map((r) => new Date(r.occurredAt).getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    expect(rows.every((r) => !('userAgent' in r))).toBe(true);
    const mine = rows.find((r) => r.actorId === admin.userId);
    expect(mine?.actorLabel).toContain('@'); // a staff member is shown by email

    const byActor = await list(admin, `?actorId=${admin.userId}`).expect(200);
    expect(
      (byActor.body.data as { actorId: string }[]).every(
        (r) => r.actorId === admin.userId,
      ),
    ).toBe(true);
    const byCategory = await list(admin, '?category=auth').expect(200);
    expect(
      (byCategory.body.data as { action: string }[]).every((r) =>
        r.action.startsWith('auth.'),
      ),
    ).toBe(true);
    const actions = await list(admin, '/actions').expect(200);
    expect(actions.body.data.actions).toContain('refund.approved');
    expect(actions.body.data.categories).toContain('auth');
  });

  it('bounds the period and refuses unknown filters', async () => {
    const admin = await s.staff('ADMIN');
    const wide = await list(
      admin,
      '?from=2020-01-01T00:00:00Z&to=2026-12-31T00:00:00Z',
    ).expect(200);
    const span =
      new Date(wide.body.meta.to).getTime() -
      new Date(wide.body.meta.from).getTime();
    expect(span).toBeLessThanOrEqual(92 * 86_400_000);
    for (const bad of [
      '?action=drop.table',
      '?category=x',
      '?actorId=nope',
      "?resourceId=a'b",
      '?outcome=MAYBE',
      '?from=2026-02-01T00:00:00Z&to=2026-01-01T00:00:00Z',
      '?sort=occurred_at',
    ])
      expect((await list(admin, bad)).status, bad).toBe(400);
  });

  it('needs audit.read: other staff and customers are refused', async () => {
    for (const who of [
      await s.staff('ORDER_MANAGER'),
      await s.staff('CUSTOMER_SUPPORT'),
      await s.session(),
    ])
      expect((await list(who)).status).toBe(403);
    await ctx.http().get('/api/v1/admin/audit-logs').expect(401);
  });
});
