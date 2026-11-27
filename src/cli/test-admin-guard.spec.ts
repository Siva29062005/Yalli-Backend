import { testAdminRefusal } from './test-admin-guard.js';

const ok = {
  NODE_ENV: 'development',
  ALLOW_TEST_ADMIN: '1',
  TEST_ADMIN_EMAIL: 'dev-admin@example.test',
  TEST_ADMIN_PASSWORD: 'a long dev password',
};

describe('testAdminRefusal', () => {
  it('allows an explicit development opt-in', () => {
    expect(testAdminRefusal(ok)).toBeNull();
  });

  it.each([
    ['production', { ...ok, NODE_ENV: 'production' }, /NODE_ENV=development/],
    ['test', { ...ok, NODE_ENV: 'test' }, /NODE_ENV=development/],
    ['unset NODE_ENV', { ...ok, NODE_ENV: undefined }, /NODE_ENV=development/],
    [
      'no opt-in flag',
      { ...ok, ALLOW_TEST_ADMIN: undefined },
      /ALLOW_TEST_ADMIN=1/,
    ],
    [
      'flag not exactly 1',
      { ...ok, ALLOW_TEST_ADMIN: 'true' },
      /ALLOW_TEST_ADMIN=1/,
    ],
    ['no email', { ...ok, TEST_ADMIN_EMAIL: ' ' }, /required/],
    ['no password', { ...ok, TEST_ADMIN_PASSWORD: '' }, /required/],
  ])('refuses: %s', (_label, env, reason) => {
    expect(testAdminRefusal(env)).toMatch(reason);
  });
});
