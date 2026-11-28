import { describe, expect, it } from 'vitest';
import { parseStockSheet } from './stock-sheet.js';

describe('go-live stock sheet', () => {
  it('reads sku,quantity rows', () => {
    expect(parseStockSheet('sku,quantity\nMOMO-1,7\n"KNIFE,1",0\n\n')).toEqual({
      rows: [
        { sku: 'MOMO-1', quantity: 7 },
        { sku: 'KNIFE,1', quantity: 0 },
      ],
      problems: [],
    });
  });

  it('reports every bad row and a wrong header', () => {
    expect(parseStockSheet('product,qty\nA,1').problems).toEqual([
      'the first line must be: sku,quantity',
    ]);
    const r = parseStockSheet(
      'sku,quantity\nA,-1\nB,2.5\nC,\n,4\nD,1\nd,2\nE,2000000',
    );
    expect(r.rows).toEqual([{ sku: 'D', quantity: 1 }]);
    expect(r.problems).toHaveLength(6);
    expect(r.problems.join('\n')).toMatch(
      /line 7 \(d\): this SKU is listed twice/,
    );
  });
});
