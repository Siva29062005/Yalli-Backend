import { INDIAN_STATES } from '../customers/dto/customer.schemas.js';
import {
  GST_STATE_CODES,
  GSTR1_CREDIT_NOTE_COLUMNS,
  creditNoteRows,
  csvCell,
  indianDate,
  placeOfSupplyCode,
  rupees,
  toCsv,
  type CreditNoteForExport,
} from './gstr1-export.js';

const note = (
  over: Partial<CreditNoteForExport> = {},
): CreditNoteForExport => ({
  creditNoteNumber: 'CN/2627/000001',
  issuedAt: new Date('2026-11-20T20:00:00Z'), // 21 Nov in India
  invoiceNumber: 'INV/2627/000010',
  invoiceDate: new Date('2026-11-01T05:00:00Z'),
  orderNumber: 'YL26-000010',
  placeOfSupply: 'Tamil Nadu',
  supply: 'INTRA_STATE',
  reason: 'Return of a faulty item',
  totalMinor: 59_000,
  lines: [
    {
      gstRateBps: 1800,
      taxableValueMinor: 40_000,
      cgstMinor: 3_600,
      sgstMinor: 3_600,
      igstMinor: 0,
    },
    {
      gstRateBps: 1800,
      taxableValueMinor: 5_000,
      cgstMinor: 450,
      sgstMinor: 450,
      igstMinor: 0,
    },
    {
      gstRateBps: 500,
      taxableValueMinor: 5_428,
      cgstMinor: 136,
      sgstMinor: 136,
      igstMinor: 0,
    },
  ],
  ...over,
});

describe('GST state codes', () => {
  it('has a code for every state and union territory an address can have', () => {
    for (const s of INDIAN_STATES)
      expect(GST_STATE_CODES[s]).toMatch(/^\d{2}$/);
    expect(new Set(Object.values(GST_STATE_CODES)).size).toBe(
      Object.keys(GST_STATE_CODES).length,
    );
  });
  it('formats the place of supply like the GST portal', () => {
    expect(placeOfSupplyCode('Tamil Nadu')).toBe('33-Tamil Nadu');
    expect(placeOfSupplyCode(' Karnataka ')).toBe('29-Karnataka');
    expect(placeOfSupplyCode('Atlantis')).toBe('Atlantis');
  });
});

describe('credit-note rows', () => {
  it('adds up the lines per GST rate, one row per rate, in India dates and exact rupees', () => {
    const rows = creditNoteRows([note()]);
    expect(rows).toHaveLength(2);
    const [r5, r18] = rows;
    expect(r5).toEqual([
      'CN/2627/000001',
      '21-11-2026',
      'C',
      'INV/2627/000010',
      '01-11-2026',
      'YL26-000010',
      '33-Tamil Nadu',
      'Intra State',
      '590.00',
      '5',
      '54.28',
      '0.00',
      '1.36',
      '1.36',
      '0.00',
      'Return of a faulty item',
    ]);
    expect(r18!.slice(9, 14)).toEqual([
      '18',
      '450.00',
      '0.00',
      '40.50',
      '40.50',
    ]);
    expect(
      rows.every((r) => r.length === GSTR1_CREDIT_NOTE_COLUMNS.length),
    ).toBe(true);
  });
  it('inter-state notes carry IGST and fractional rates keep their decimals', () => {
    const [row] = creditNoteRows([
      note({
        placeOfSupply: 'Karnataka',
        supply: 'INTER_STATE',
        lines: [
          {
            gstRateBps: 25,
            taxableValueMinor: 10_000,
            cgstMinor: 0,
            sgstMinor: 0,
            igstMinor: 25,
          },
        ],
      }),
    ]);
    expect(row!.slice(6, 14)).toEqual([
      '29-Karnataka',
      'Inter State',
      '590.00',
      '0.25',
      '100.00',
      '0.25',
      '0.00',
      '0.00',
    ]);
  });
});

describe('CSV safety and format', () => {
  it('neutralises spreadsheet formulas in any cell, but not negative amounts', () => {
    for (const evil of [
      '=HYPERLINK("http://x")',
      '+1+1',
      '-2+3',
      '@SUM(A1)',
      '\tx',
      '\rx',
    ])
      expect(csvCell(evil).startsWith(`"'`)).toBe(true);
    expect(csvCell('-12.50')).toBe('"-12.50"');
    expect(csvCell('He said "hi", then left')).toBe(
      '"He said ""hi"", then left"',
    );
  });
  it('writes a header and CRLF rows', () => {
    const csv = toCsv(['A', 'B'], [['1', 'x,y']]);
    expect(csv).toBe('"A","B"\r\n"1","x,y"\r\n');
  });
  it('rupees from paise without floating point', () => {
    expect(rupees(0)).toBe('0.00');
    expect(rupees(5)).toBe('0.05');
    expect(rupees(123_456_789)).toBe('1234567.89');
    expect(rupees(-150)).toBe('-1.50');
    expect(() => rupees(1.5)).toThrow(RangeError);
  });
  it('dates are India calendar days', () => {
    expect(indianDate(new Date('2026-03-31T19:00:00Z'))).toBe('01-04-2026');
  });
});
