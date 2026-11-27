import { Logger } from '@nestjs/common';
import { CaptchaVerifier } from '../../src/modules/identity/ports/ports.js';
import {
  createTestApp,
  freshIp,
  type TestContext,
} from '../support/test-app.js';

let ctx: TestContext;
beforeAll(async () => {
  Logger.overrideLogger(false);
  ctx = await createTestApp();
});
afterAll(() => ctx.close());

const send = (body: Record<string, unknown>, ip = freshIp()) =>
  ctx.http().post('/api/v1/contact').set('X-Forwarded-For', ip).send(body);
const valid = (over: Record<string, unknown> = {}) => ({
  name: 'Asha Kumar',
  email: `asha.${Math.random().toString(36).slice(2, 8)}@example.test`,
  topic: 'ORDER',
  orderNumber: 'YL26-1001',
  message: 'My parcel says delivered but it has not arrived yet.',
  ...over,
});

describe('contact form', () => {
  it('stores a message as plain text and answers 202', async () => {
    const body = valid({
      message: 'Lid is <b>cracked</b> & leaking <script>x()</script>badly',
    });
    const res = await send(body);
    expect(res.status).toBe(202);
    const row = await ctx.prisma.contactMessage.findFirstOrThrow({
      where: { email: body.email },
    });
    expect(row).toMatchObject({
      name: 'Asha Kumar',
      topic: 'ORDER',
      orderNumber: 'YL26-1001',
      status: 'NEW',
    });
    expect(row.message).toBe('Lid is cracked & leaking badly');
  });

  it('refuses unknown fields, a bad email, a bad topic and too little text', async () => {
    for (const body of [
      valid({ admin: true }),
      valid({ email: 'not-an-email' }),
      valid({ topic: 'REFUND_ME_NOW' }),
      valid({ message: 'hi' }),
      valid({ message: '<b></b><i>tiny</i>' }),
      valid({ orderNumber: 'DROP TABLE;' }),
      // 5 emoji are 10 UTF-16 units but only 5 characters: a 400, not a database error
      valid({ message: '😀😀😀😀😀' }),
    ])
      expect((await send(body)).status).toBe(400);
  });

  it('counts the per-address cap only after the captcha passed', async () => {
    const email = `victim.${Date.now()}@example.test`;
    const captcha = ctx.app.get(CaptchaVerifier);
    const spy = vi.spyOn(captcha, 'verify').mockResolvedValue(false);
    try {
      for (let i = 0; i < 5; i++)
        expect((await send(valid({ email }))).status).toBe(400);
    } finally {
      spy.mockRestore();
    }
    // the refused attempts did not use up the real sender's budget
    expect((await send(valid({ email }))).status).toBe(202);
  });

  it('is rate-limited per IP address as well', async () => {
    const ip = freshIp();
    const statuses = [];
    for (let i = 0; i < 11; i++)
      statuses.push((await send(valid(), ip)).status);
    expect(statuses.slice(0, 10).every((x) => x === 202)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  it('drops a bot that fills the hidden field, without telling it', async () => {
    const body = valid({ website: 'https://spam.example' });
    expect((await send(body)).status).toBe(202);
    expect(
      await ctx.prisma.contactMessage.count({ where: { email: body.email } }),
    ).toBe(0);
  });

  it('is rate-limited per address', async () => {
    const email = `limit.${Date.now()}@example.test`;
    const statuses = [];
    for (let i = 0; i < 4; i++)
      statuses.push((await send(valid({ email }))).status);
    expect(statuses).toEqual([202, 202, 202, 429]);
  });
});
