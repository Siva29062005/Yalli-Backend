import type { CreditNote, Invoice } from './account-api';
import { formatPaise } from './formatters';

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Printable invoice document. Every value is HTML-escaped: names and addresses are user input. */
export function invoiceHtml(inv: Invoice): string {
  const intra = inv.supply === 'INTRA_STATE';
  const rows = inv.lines
    .map(
      (l) => `<tr>
        <td>${esc(l.description)}<div class="muted">${[l.sku ? esc(l.sku) : '', l.hsn ? `HSN ${esc(l.hsn)}` : ''].filter(Boolean).join(' · ')}</div></td>
        <td class="r">${l.quantity}</td>
        <td class="r">${esc(formatPaise(l.unitPriceMinor))}</td>
        <td class="r">${esc(formatPaise(l.taxableValueMinor))}</td>
        <td class="r">${(l.gstRateBps / 100).toFixed(1)}%</td>
        ${intra ? `<td class="r">${esc(formatPaise(l.cgstMinor))}</td><td class="r">${esc(formatPaise(l.sgstMinor))}</td>` : `<td class="r">${esc(formatPaise(l.igstMinor))}</td>`}
        <td class="r">${esc(formatPaise(l.lineTotalMinor))}</td>
      </tr>`,
    )
    .join('');
  const t = inv.totals;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(inv.invoiceNumber)}</title>
<style>
body{font:14px/1.5 system-ui,sans-serif;color:#113322;max-width:900px;margin:32px auto;padding:0 16px}
h1{font-size:22px;margin:0}.muted{color:#8A958E;font-size:12px}table{width:100%;border-collapse:collapse;margin:24px 0}
th,td{border-bottom:1px solid #E6EAE7;padding:8px;text-align:left;vertical-align:top}.r{text-align:right}
.grid{display:flex;flex-wrap:wrap;gap:32px;justify-content:space-between}.warn{background:#FFF7E6;padding:8px 12px;border-radius:8px}
@media print{button{display:none}}
</style></head><body>
<div class="grid"><div><h1>${inv.taxInvoice ? 'Tax invoice' : 'Invoice'}</h1>
<div>${esc(inv.invoiceNumber)} · ${esc(new Date(inv.invoiceDate).toLocaleDateString('en-IN'))}</div>
<div class="muted">Order ${esc(inv.orderNumber)}</div></div>
<div><strong>${esc(inv.seller.name)}</strong><div>${esc(inv.seller.state)}</div>${inv.seller.gstin ? `<div>GSTIN ${esc(inv.seller.gstin)}</div>` : ''}</div></div>
${inv.taxInvoice ? '' : '<p class="warn">This is a receipt. A GST tax invoice will be issued once the seller GSTIN is registered.</p>'}
<p><strong>Billed to:</strong> ${esc(inv.buyer.name)} (${esc(inv.buyer.email)})<br><span class="muted">Place of supply: ${esc(inv.placeOfSupply)}</span></p>
<table><thead><tr><th>Item</th><th class="r">Qty</th><th class="r">Unit price</th><th class="r">Taxable</th><th class="r">GST</th>
${intra ? '<th class="r">CGST</th><th class="r">SGST</th>' : '<th class="r">IGST</th>'}<th class="r">Total</th></tr></thead><tbody>${rows}</tbody></table>
<table style="width:auto;margin-left:auto">
${Object.entries(t)
  .filter(([, v]) => typeof v === 'number')
  .map(([k, v]) => `<tr><td>${esc(k.replace(/Minor$/, '').replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase()))}</td><td class="r">${esc(formatPaise(v))}</td></tr>`)
  .join('')}
</table>
<button onclick="window.print()">Print / save as PDF</button>
</body></html>`;
}

/** Printable GST credit note. Same escaping as the invoice: names, reasons and addresses are user input. */
export function creditNoteHtml(cn: CreditNote): string {
  const intra = cn.supply === 'INTRA_STATE';
  const rows = cn.lines
    .map(
      (l) => `<tr>
        <td>${esc(l.description)}${l.hsn ? `<div class="muted">HSN ${esc(l.hsn)}</div>` : ''}</td>
        <td class="r">${esc(formatPaise(l.taxableValueMinor))}</td>
        <td class="r">${(l.gstRateBps / 100).toFixed(1)}%</td>
        ${intra ? `<td class="r">${esc(formatPaise(l.cgstMinor))}</td><td class="r">${esc(formatPaise(l.sgstMinor))}</td>` : `<td class="r">${esc(formatPaise(l.igstMinor))}</td>`}
        <td class="r">${esc(formatPaise(l.totalMinor))}</td>
      </tr>`,
    )
    .join('');
  const t = cn.totals;
  const total = (label: string, v: number) => `<tr><td>${esc(label)}</td><td class="r">${esc(formatPaise(v))}</td></tr>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(cn.creditNoteNumber)}</title>
<style>
body{font:14px/1.5 system-ui,sans-serif;color:#113322;max-width:900px;margin:32px auto;padding:0 16px}
h1{font-size:22px;margin:0}.muted{color:#8A958E;font-size:12px}table{width:100%;border-collapse:collapse;margin:24px 0}
th,td{border-bottom:1px solid #E6EAE7;padding:8px;text-align:left;vertical-align:top}.r{text-align:right}
.grid{display:flex;flex-wrap:wrap;gap:32px;justify-content:space-between}.warn{background:#FFF7E6;padding:8px 12px;border-radius:8px}
@media print{button{display:none}}
</style></head><body>
<div class="grid"><div><h1>${cn.taxDocument ? 'Credit note (GST)' : 'Credit note'}</h1>
<div>${esc(cn.creditNoteNumber)} · ${esc(new Date(cn.issuedAt).toLocaleDateString('en-IN'))}</div>
<div class="muted">Against invoice ${esc(cn.invoiceNumber)} · order ${esc(cn.orderNumber)}</div></div>
<div><strong>${esc(cn.seller.name)}</strong><div>${esc(cn.seller.state)}</div>${cn.seller.gstin ? `<div>GSTIN ${esc(cn.seller.gstin)}</div>` : ''}</div></div>
${cn.taxDocument ? '' : '<p class="warn">This is a record of your refund. A GST credit note is issued once the seller GSTIN is registered.</p>'}
<p><strong>Issued to:</strong> ${esc(cn.buyer.name)} (${esc(cn.buyer.email)})<br><span class="muted">Place of supply: ${esc(cn.placeOfSupply)}</span><br><span class="muted">Reason: ${esc(cn.reason)}</span></p>
<table><thead><tr><th>Item</th><th class="r">Taxable</th><th class="r">GST</th>
${intra ? '<th class="r">CGST</th><th class="r">SGST</th>' : '<th class="r">IGST</th>'}<th class="r">Total</th></tr></thead><tbody>${rows}</tbody></table>
<table style="width:auto;margin-left:auto">
${total('Taxable value', t.taxableValueMinor)}${intra ? total('CGST', t.cgstMinor) + total('SGST', t.sgstMinor) : total('IGST', t.igstMinor)}${total('Total credited', t.totalMinor)}
</table>
<button onclick="window.print()">Print / save as PDF</button>
</body></html>`;
}
