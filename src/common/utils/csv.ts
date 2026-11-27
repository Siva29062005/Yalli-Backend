/**
 * CSV for spreadsheet tools. Every cell is quoted (quotes doubled), and a cell a spreadsheet would treat as a formula
 * (= + - @, tab, CR at the start) gets an apostrophe in front, so text typed by customers or staff can never run as
 * a formula when the file is opened (CSV injection). Plain negative amounts ("-12.50") are left as they are.
 */
const FORMULA_START = /^[=+\-@\t\r]/;

/** One CSV cell: quoted, quotes doubled, a leading formula character neutralised. */
export function csvCell(value: string): string {
  const safe =
    FORMULA_START.test(value) && !/^-\d+(\.\d+)?$/.test(value)
      ? `'${value}`
      : value;
  return `"${safe.replace(/"/g, '""')}"`;
}

/** CSV text with a header row and CRLF line ends (what spreadsheet tools expect). */
export function toCsv(
  header: readonly string[],
  rows: readonly string[][],
): string {
  return (
    [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n'
  );
}
