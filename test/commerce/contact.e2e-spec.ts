import { Logger } from '@nestjs/common';
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
    ])
      expect((await send(body)).status).toBe(400);
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
