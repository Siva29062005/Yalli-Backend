import { passwordViolations } from './password-policy.js';

describe('passwordViolations', () => {
  it('accepts a long, unrelated passphrase', () => {
    expect(
      passwordViolations('correct-horse-battery-staple', {
        email: 'jane.smith@example.com',
        firstName: 'Jane',
        lastName: 'Smith',
      }),
    ).toEqual([]);
  });
  it('rejects too short / too long / repetitive', () => {
    expect(passwordViolations('short1!')).toEqual(
      expect.arrayContaining([expect.stringContaining('at least 12')]),
    );
    expect(passwordViolations('x'.repeat(129))).toEqual(
      expect.arrayContaining([expect.stringContaining('at most 128')]),
    );
    expect(passwordViolations('abababababababab')).toEqual(
      expect.arrayContaining([expect.stringContaining('repetitive')]),
    );
  });
  it('rejects passwords containing ANY word of the email local part or the name', () => {
    expect(
      passwordViolations('my-smith-secret-2024', {
        email: 'jane.smith@example.com',
      }),
    ).toEqual(expect.arrayContaining([expect.stringContaining('email name')]));
    expect(
      passwordViolations('jane-loves-banana-pie', {
        email: 'jane.smith@example.com',
      }),
    ).toEqual(expect.arrayContaining([expect.stringContaining('email name')]));
    expect(
      passwordViolations('prefix-Priya-suffix-77', { firstName: 'Priya' }),
    ).toEqual(expect.arrayContaining([expect.stringContaining('your name')]));
  });
  it('ignores short or purely numeric local-part words (no false positives)', () => {
    expect(
      passwordViolations('unrelated-long-password-1979', {
        email: 'jo.1979@example.com',
      }),
    ).toEqual([]);
  });
});
