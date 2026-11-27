import { creditNoteAttachment } from './credit-note-document.js';
import type { CreditNoteDocument } from '../ports/ports.js';

const cn = (over: Partial<CreditNoteDocument> = {}): CreditNoteDocument => ({
  creditNoteNumber: 'CN/2627/000001',
  issuedAt: '2026-11-20T20:00:00Z',
  invoiceNumber: 'INV/2627/000010',
  orderNumber: 'YL26-000010',
  reason: 'Return <script>alert(1)</script>',
  taxDocument: true,
  seller: { name: 'Yalli & Co', state: 'Tamil Nadu', gstin: '33ABCDE1234F1Z5' },
  buyer: { name: '<img src=x onerror=alert(1)>', email: 'a@b.c' },
  placeOfSupply: 'Tamil Nadu',
  supply: 'INTRA_STATE',
  lines: [
    {
      description: 'Pot "large"',
      hsn: '7323',
      gstRateBps: 1800,
      taxableValueMinor: 10_000,
      cgstMinor: 900,
      sgstMinor: 900,
      igstMinor: 0,
      totalMinor: 11_800,
    },
  ],
  totals: {
    taxableValueMinor: 10_000,
    cgstMinor: 900,
    sgstMinor: 900,
    igstMinor: 0,
    totalMinor: 11_800,
  },
  ...over,
});

describe('credit note attachment', () => {
  it('escapes every value and has no script, link or external resource', () => {
    const a = creditNoteAttachment(cn());
    expect(a.filename).toBe('credit-note-CN-2627-000001.html');
    // no live markup from the data: tags only ever appear escaped
    expect(a.content).not.toMatch(/<script|<img|<a\s|<link|<iframe|url\(/i);
    expect(a.content).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(a.content).toContain('&lt;script&gt;');
    expect(a.content).toContain('Yalli &amp; Co');
    expect(a.content).toContain('Pot &quot;large&quot;');
    expect(a.content).toContain('₹118.00');
    expect(a.content).toContain('CGST');
    expect(a.content).toContain('21 Nov 2026'); // India date
  });
  it('inter-state notes show IGST; before GST registration it says it is a refund record', () => {
    const a = creditNoteAttachment(
      cn({
        supply: 'INTER_STATE',
        taxDocument: false,
        seller: { name: 'Yalli', state: 'Tamil Nadu', gstin: null },
      }),
    );
    expect(a.content).toContain('IGST');
    expect(a.content).not.toContain('<th class="r">CGST');
    expect(a.content).toContain('record of your refund');
    expect(a.content).not.toMatch(/GSTIN \d/);
  });
});
