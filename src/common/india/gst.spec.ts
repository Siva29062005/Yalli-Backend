import { checkGstin, gstinCheckChar } from './gst.js';

describe('GSTIN check', () => {
  it('accepts a real-format GSTIN with the right check character and names its state', () => {
    // the GST portal's own example
    expect(checkGstin('27AAPFU0939F1ZV')).toEqual({
      ok: true,
      stateCode: '27',
      state: 'Maharashtra',
      pan: 'AAPFU0939F',
    });
    expect(checkGstin(' 33abcde1234f1z7 ')).toMatchObject({
      ok: true,
      state: 'Tamil Nadu',
    });
    expect(gstinCheckChar('27AAPFU0939F1Z')).toBe('V');
  });
  it('refuses typos, bad shapes and unknown state codes', () => {
    expect(checkGstin('27AAPFU0939F1ZW')).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/check character/),
    });
    expect(checkGstin('27AAPFU0939F1Z')).toMatchObject({ ok: false });
    expect(checkGstin('27AAPFU0939F1YV')).toMatchObject({ ok: false }); // 14th character must be Z
    expect(checkGstin('2AAAPFU0939F1ZV')).toMatchObject({ ok: false });
    const bad = '25AAPFU0939F1Z';
    expect(checkGstin(bad + gstinCheckChar(bad))).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/state code 25/),
    });
  });
});
