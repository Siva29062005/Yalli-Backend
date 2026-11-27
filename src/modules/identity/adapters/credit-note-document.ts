import type { CreditNoteDocument, EmailAttachment } from '../ports/ports.js';
import { escapeHtml, formatInr } from './notification-templates.js';

/**
 * The credit note as a standalone HTML document, attached to the refund email (pure, unit-tested). Every value is
 * escaped (names, reasons and addresses are typed by people); there is no script, no external resource and no link.
 * Muted text uses #5F6B64 (WCAG AA on white).
 */
export function creditNoteAttachment(cn: CreditNoteDocument): EmailAttachment {
  const intra = cn.supply === 'INTRA_STATE';
  const date = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(new Date(cn.issuedAt));
  const rate = (bps: number) => `${(bps / 100).toFixed(bps % 100 ? 2 : 0)}%`;
  const td = (v: string, right = false) =>
    `<td${right ? ' class="r"' : ''}>${escapeHtml(v)}</td>`;
  const rows = cn.lines
    .map(
      (l) =>
        `<tr><td>${escapeHtml(l.description)}${l.hsn ? `<div class="m">HSN ${escapeHtml(l.hsn)}</div>` : ''}</td>` +
        td(formatInr(l.taxableValueMinor), true) +
        td(rate(l.gstRateBps), true) +
        (intra
          ? td(formatInr(l.cgstMinor), true) + td(formatInr(l.sgstMinor), true)
          : td(formatInr(l.igstMinor), true)) +
        td(formatInr(l.totalMinor), true) +
        '</tr>',
    )
    .join('');
  const total = (label: string, v: number) =>
    `<tr>${td(label)}${td(formatInr(v), true)}</tr>`;
  const t = cn.totals;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(cn.creditNoteNumber)}</title>
<style>body{font:14px/1.5 Arial,Helvetica,sans-serif;color:#113322;max-width:900px;margin:32px auto;padding:0 16px}
h1{font-size:22px;margin:0}.m{color:#5F6B64;font-size:12px}table{width:100%;border-collapse:collapse;margin:24px 0}
th,td{border-bottom:1px solid #E6EAE7;padding:8px;text-align:left;vertical-align:top}.r{text-align:right}
.w{background:#FFF7E6;padding:8px 12px;border-radius:8px}</style></head><body>
<h1>${cn.taxDocument ? 'Credit note (GST)' : 'Credit note'}</h1>
<p>${escapeHtml(cn.creditNoteNumber)} · ${escapeHtml(date)}<br><span class="m">Against invoice ${escapeHtml(cn.invoiceNumber)} · order ${escapeHtml(cn.orderNumber)}</span></p>
<p><strong>${escapeHtml(cn.seller.name)}</strong><br>${escapeHtml(cn.seller.state)}${cn.seller.gstin ? `<br>GSTIN ${escapeHtml(cn.seller.gstin)}` : ''}</p>
${cn.taxDocument ? '' : '<p class="w">This is a record of your refund. A GST credit note is issued once the seller GSTIN is registered.</p>'}
<p><strong>Issued to:</strong> ${escapeHtml(cn.buyer.name)} (${escapeHtml(cn.buyer.email)})<br><span class="m">Place of supply: ${escapeHtml(cn.placeOfSupply)} · Reason: ${escapeHtml(cn.reason)}</span></p>
<table><thead><tr><th>Item</th><th class="r">Taxable</th><th class="r">GST</th>${intra ? '<th class="r">CGST</th><th class="r">SGST</th>' : '<th class="r">IGST</th>'}<th class="r">Total</th></tr></thead><tbody>${rows}</tbody></table>
<table style="width:auto;margin-left:auto">${total('Taxable value', t.taxableValueMinor)}${intra ? total('CGST', t.cgstMinor) + total('SGST', t.sgstMinor) : total('IGST', t.igstMinor)}${total('Total credited', t.totalMinor)}</table>
</body></html>`;
  return {
    // "CN/2627/000001" -> "credit-note-CN-2627-000001.html" (safe for a MIME header)
    filename: `credit-note-${cn.creditNoteNumber.replace(/[^A-Za-z0-9]+/g, '-')}.html`,
    contentType: 'text/html',
    content: html,
  };
}
