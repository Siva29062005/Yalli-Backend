/** GST state codes (first two digits of a GSTIN), keyed by the state names used in addresses. */
export const GST_STATE_CODES: Readonly<Record<string, string>> = {
  'Jammu and Kashmir': '01',
  'Himachal Pradesh': '02',
  Punjab: '03',
  Chandigarh: '04',
  Uttarakhand: '05',
  Haryana: '06',
  Delhi: '07',
  Rajasthan: '08',
  'Uttar Pradesh': '09',
  Bihar: '10',
  Sikkim: '11',
  'Arunachal Pradesh': '12',
  Nagaland: '13',
  Manipur: '14',
  Mizoram: '15',
  Tripura: '16',
  Meghalaya: '17',
  Assam: '18',
  'West Bengal': '19',
  Jharkhand: '20',
  Odisha: '21',
  Chhattisgarh: '22',
  'Madhya Pradesh': '23',
  Gujarat: '24',
  'Dadra and Nagar Haveli and Daman and Diu': '26',
  Maharashtra: '27',
  Karnataka: '29',
  Goa: '30',
  Lakshadweep: '31',
  Kerala: '32',
  'Tamil Nadu': '33',
  Puducherry: '34',
  'Andaman and Nicobar Islands': '35',
  Telangana: '36',
  'Andhra Pradesh': '37',
  Ladakh: '38',
};

const CHARSET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
/** 2-digit state code, 10-character PAN, entity number, "Z", check character. */
const GSTIN_SHAPE = /^(\d{2})([A-Z]{5}\d{4}[A-Z])([1-9A-Z])Z([0-9A-Z])$/;

/** The GSTIN check character (mod-36 with alternating weights 1, 2 over the first 14 characters). */
export function gstinCheckChar(first14: string): string {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const p = CHARSET.indexOf(first14[i]!) * (i % 2 ? 2 : 1);
    sum += Math.floor(p / 36) + (p % 36);
  }
  return CHARSET[(36 - (sum % 36)) % 36]!;
}

export type GstinCheck =
  | { ok: true; stateCode: string; state: string | null; pan: string }
  | { ok: false; reason: string };

/** Shape, check character and state code of a GSTIN (pure, unit-tested). */
export function checkGstin(value: string): GstinCheck {
  const g = value.trim().toUpperCase();
  const m = GSTIN_SHAPE.exec(g);
  if (!m)
    return {
      ok: false,
      reason:
        'must be 15 characters: state code, PAN, entity number, Z, check character',
    };
  if (gstinCheckChar(g.slice(0, 14)) !== g[14])
    return { ok: false, reason: 'the check character is wrong (a typo?)' };
  // 25 (Daman and Diu) was merged into 26 in 2020; registrations made before keep their GSTIN
  const code = m[1] === '25' ? '26' : m[1];
  const state =
    Object.entries(GST_STATE_CODES).find(([, c]) => c === code)?.[0] ?? null;
  if (!state && m[1] !== '97')
    return {
      ok: false,
      reason: `state code ${m[1]} is not an Indian state code`,
    };
  return { ok: true, stateCode: m[1]!, state, pan: m[2]! };
}
