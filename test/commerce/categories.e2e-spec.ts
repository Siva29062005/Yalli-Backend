import { randomUUID } from 'node:crypto';
import {
  Scenario,
  authed,
  createTestApp,
  type TestContext,
} from '../support/test-app.js';

let ctx: TestContext;
let scenario: Scenario;
beforeAll(async () => {
  ctx = await createTestApp();
  scenario = new Scenario(ctx);
});
afterAll(async () => {
  await ctx.close();
});

it('lists hidden categories for authorised staff, updates visibility/order, and deletes empty categories', async () => {
  const admin = await scenario.staff('ADMIN');
  const slug = `collection-${randomUUID()}`;
  const created = await ctx
    .http()
    .post('/api/v1/admin/categories')
    .set(authed(admin))
    .send({ name: 'Seasonal collection', slug, isActive: false, position: 9 })
    .expect(201);
  const id = created.body.data.id;
  const listed = await ctx
    .http()
    .get('/api/v1/admin/categories')
    .set(authed(admin))
    .expect(200);
  expect(listed.headers['cache-control'] ?? '').not.toContain('public');
  expect(listed.body.data).toContainEqual(
    expect.objectContaining({
      id,
      isActive: false,
      position: 9,
      _count: { products: 0, children: 0 },
    }),
  );
  const hidden = await ctx.http().get('/api/v1/catalog/categories').expect(200);
  expect(hidden.body.data).not.toContainEqual(expect.objectContaining({ id }));
  await ctx
    .http()
    .patch(`/api/v1/admin/categories/${id}`)
    .set(authed(admin))
    .send({ name: 'Renamed collection', isActive: true, position: 2 })
    .expect(200);
  const visible = await ctx
    .http()
    .get('/api/v1/catalog/categories')
    .expect(200);
  expect(visible.body.data).toContainEqual(
    expect.objectContaining({ id, name: 'Renamed collection' }),
  );
  await ctx
    .http()
    .post('/api/v1/admin/categories')
    .set(authed(admin))
    .send({ name: 'Duplicate', slug })
    .expect(409);
  await ctx
    .http()
    .delete(`/api/v1/admin/categories/${id}`)
    .set(authed(admin))
    .expect(200);
  const deleted = await ctx
    .http()
    .get('/api/v1/admin/categories')
    .set(authed(admin))
    .expect(200);
  expect(deleted.body.data).not.toContainEqual(expect.objectContaining({ id }));
});

it('denies anonymous and customer access and limits deletion to administrator permissions', async () => {
  await ctx.http().get('/api/v1/admin/categories').expect(401);
  const customer = await scenario.session();
  await ctx
    .http()
    .get('/api/v1/admin/categories')
    .set(authed(customer))
    .expect(403);
  await ctx
    .http()
    .post('/api/v1/admin/categories')
    .set(authed(customer))
    .send({ name: 'Denied' })
    .expect(403);
  const manager = await scenario.staff('PRODUCT_MANAGER');
  const created = await ctx
    .http()
    .post('/api/v1/admin/categories')
    .set(authed(manager))
    .send({ name: `Manager ${randomUUID()}` })
    .expect(201);
  await ctx
    .http()
    .get('/api/v1/admin/categories')
    .set(authed(manager))
    .expect(200);
  await ctx
    .http()
    .delete(`/api/v1/admin/categories/${created.body.data.id}`)
    .set(authed(manager))
    .expect(403);
});

it('lists brands with ids for staff with product access only', async () => {
  const manager = await scenario.staff('PRODUCT_MANAGER');
  const name = `Brand ${randomUUID()}`;
  const created = await ctx
    .http()
    .post('/api/v1/admin/brands')
    .set(authed(manager))
    .send({ name })
    .expect(201);
  const listed = await ctx
    .http()
    .get('/api/v1/admin/brands')
    .set(authed(manager))
    .expect(200);
  expect(listed.body.data).toContainEqual({
    id: created.body.data.id,
    name,
    slug: created.body.data.slug,
    _count: { products: 0 },
  });
  await ctx.http().get('/api/v1/admin/brands').expect(401);
  await ctx
    .http()
    .get('/api/v1/admin/brands')
    .set(authed(await scenario.session()))
    .expect(403);
});
