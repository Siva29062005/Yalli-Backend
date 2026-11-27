/**
 * Credit-note register as CSV for GST filing (pure, unit-tested). One row per credit note per GST rate, the way the
 * credit/debit-note tables of GSTR-1 are filled in (CDNUR for unregistered buyers, or netted in B2CS for small B2C
 * supplies: which table applies is the accountant's call, see docs/policies/store-policies-and-tax.md).
 *
 * Safety: every cell is quoted, and a cell that a spreadsheet would treat as a formula (= + - @, tab, CR) is prefixed
 * with an apostrophe, so customer-typed text (names, reasons) can never run as a formula when the file is opened.
 */

import { csvCell, toCsv } from '../../common/utils/csv.js';

export { csvCell, toCsv };

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

/** "33-Tamil Nadu", the place-of-supply format of the GST portal; the bare name if the state is unknown. */
export function placeOfSupplyCode(state: string): string {
  const code = GST_STATE_CODES[state.trim()];
  return code ? `${code}-${state.trim()}` : state.trim();
}

export interface CreditNoteForExport {
  creditNoteNumber: string;
  issuedAt: Date;
  invoiceNumber: string;
  invoiceDate: Date | null;
  orderNumber: string;
  placeOfSupply: string;
  supply: string;
  reason: string;
  totalMinor: number;
  lines: {
    gstRateBps: number;
    taxableValueMinor: number;
    cgstMinor: number;
    sgstMinor: number;
    igstMinor: number;
  }[];
}

export const GSTR1_CREDIT_NOTE_COLUMNS = [
  'Note number',
  'Note date',
  'Note type',
  'Original invoice number',
  'Original invoice date',
  'Order number',
  'Place of supply',
  'Supply type',
  'Note value',
  'Rate (%)',
  'Taxable value',
  'IGST',
  'CGST',
  'SGST',
  'Cess',
  'Reason',
] as const;

/** Paise -> "1234.56" (integer maths only; never a float). */
export function rupees(minor: number): string {
  if (!Number.isSafeInteger(minor))
    throw new RangeError('amount must be an integer of paise');
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** dd-mm-yyyy in India time (the date format of the GST portal's offline tool). */
export function indianDate(d: Date): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('day')}-${get('month')}-${get('year')}`;
}

/** yyyy-mm-dd in India time (file names: India midnight on the 1st is still the previous day in UTC). */
export function indianIsoDate(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/** One row per (credit note, GST rate): lines of the same rate are added up. */
export function creditNoteRows(
  notes: readonly CreditNoteForExport[],
): string[][] {
  const rows: string[][] = [];
  for (const n of notes) {
    const byRate = new Map<
      number,
      { taxable: number; cgst: number; sgst: number; igst: number }
    >();
    for (const l of n.lines) {
      const acc = byRate.get(l.gstRateBps) ?? {
        taxable: 0,
        cgst: 0,
        sgst: 0,
        igst: 0,
      };
      acc.taxable += l.taxableValueMinor;
      acc.cgst += l.cgstMinor;
      acc.sgst += l.sgstMinor;
      acc.igst += l.igstMinor;
      byRate.set(l.gstRateBps, acc);
    }
    for (const [rateBps, t] of [...byRate.entries()].sort(
      (a, b) => a[0] - b[0],
    )) {
      rows.push([
        n.creditNoteNumber,
        indianDate(n.issuedAt),
        'C',
        n.invoiceNumber,
        n.invoiceDate ? indianDate(n.invoiceDate) : '',
        n.orderNumber,
        placeOfSupplyCode(n.placeOfSupply),
        n.supply === 'INTER_STATE' ? 'Inter State' : 'Intra State',
        rupees(n.totalMinor),
        // basis points -> percent with up to two decimals ("18", "0.25")
        `${Math.trunc(rateBps / 100)}${
          rateBps % 100
            ? `.${String(rateBps % 100)
                .padStart(2, '0')
                .replace(/0$/, '')}`
            : ''
        }`,
        rupees(t.taxable),
        rupees(t.igst),
        rupees(t.cgst),
        rupees(t.sgst),
        '0.00',
        n.reason,
      ]);
    }
  }
  return rows;
}
