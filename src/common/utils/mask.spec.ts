import { maskEmail, maskPhone } from './mask.js';

describe('masking contact details for staff', () => {
  it('emails keep the first characters and the domain', () => {
    expect(maskEmail('priya.r@example.com')).toBe('pr•••@example.com');
    expect(maskEmail('ab@x.in')).toBe('a•••@x.in');
    expect(maskEmail('a@x.in')).toBe('a•••@x.in');
    expect(maskEmail('weird@local@x.in')).toBe('we•••@x.in');
    expect(maskEmail('no-at-sign')).toBe('•••');
    expect(maskEmail('@x.in')).toBe('•••');
  });
  it('phones keep only the last four digits', () => {
    expect(maskPhone('+919876543210')).toBe('+91 ••••• •3210');
    expect(maskPhone('+447700900123')).toBe('+••••• •0123');
    expect(maskPhone('12')).toBe('•••');
    expect(maskPhone('+919876543210')).not.toContain('98765');
  });
});
