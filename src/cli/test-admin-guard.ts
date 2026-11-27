/**
 * `create-test-admin` makes a SUPER_ADMIN with a known TOTP secret, so it must never run by accident: it needs an
 * explicit development environment AND an opt-in flag. Returns the reason it is refused, or null when allowed.
 */
export function testAdminRefusal(env: NodeJS.ProcessEnv): string | null {
  if (env['NODE_ENV'] !== 'development')
    return 'create-test-admin runs only with NODE_ENV=development';
  if (env['ALLOW_TEST_ADMIN'] !== '1')
    return 'create-test-admin needs ALLOW_TEST_ADMIN=1 (it creates a SUPER_ADMIN with a known MFA secret)';
  if (!env['TEST_ADMIN_EMAIL']?.trim() || !env['TEST_ADMIN_PASSWORD'])
    return 'TEST_ADMIN_EMAIL and TEST_ADMIN_PASSWORD are required';
  return null;
}
