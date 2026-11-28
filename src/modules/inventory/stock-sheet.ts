import { parseCsv } from '../catalog/import/opencart.js';

/**
 * The go-live stock sheet (`stock.csv` from convert:opencart, or one exported again at the cut-over): `sku,quantity`,
 * one row per SKU. Pure (unit-tested); `npm run set:stock` applies it. The WHOLE sheet is checked first.
 */
export interface StockRow {
  sku: string;
  quantity: number;
}

export function parseStockSheet(csv: string): {
  rows: StockRow[];
  problems: string[];
} {
  const lines = parseCsv(csv).filter((r) => r.some((c) => c.trim() !== ''));
  const problems: string[] = [];
  const header = (lines[0] ?? []).map((c) => c.trim().toLowerCase());
  if (header[0] !== 'sku' || header[1] !== 'quantity')
    return { rows: [], problems: ['the first line must be: sku,quantity'] };
  const rows: StockRow[] = [];
  const seen = new Set<string>();
  lines.slice(1).forEach((r, i) => {
    const line = i + 2;
    const sku = (r[0] ?? '').trim();
    const raw = (r[1] ?? '').trim();
    if (!sku || sku.length > 64) {
      problems.push(`line ${line}: missing or too long SKU`);
      return;
    }
    if (!/^\d{1,7}$/.test(raw) || Number(raw) > 1_000_000) {
      problems.push(
        `line ${line} (${sku}): quantity must be a whole number from 0 to 1,000,000`,
      );
      return;
    }
    const key = sku.toUpperCase();
    if (seen.has(key)) {
      problems.push(`line ${line} (${sku}): this SKU is listed twice`);
      return;
    }
    seen.add(key);
    rows.push({ sku, quantity: Number(raw) });
  });
  if (lines.length > 20_001) problems.push('at most 20,000 rows');
  return { rows, problems };
}
