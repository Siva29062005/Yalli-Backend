import { describe, expect, it } from 'vitest';
import { RequirePermissions } from './access.decorators.js';

describe('@RequirePermissions', () => {
  it('refuses an empty list (it would let any signed-in user through)', () => {
    expect(() => RequirePermissions()).toThrow(/at least one permission/);
    expect(() => RequirePermissions('')).toThrow(/at least one permission/);
    expect(() => RequirePermissions('orders.read')).not.toThrow();
  });
});
