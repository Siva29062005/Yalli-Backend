import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { toCsv } from '../common/utils/csv.js';
import { parseImportFile } from '../modules/catalog/import/import-file.js';
import {
  TAX_SHEET_COLUMNS,
  convertOpenCart,
  parseTaxSheet,
  readPhpMyAdminJson,
} from '../modules/catalog/import/opencart.js';

/**
 * Converts a phpMyAdmin JSON export of the OpenCart store into the catalogue import file (and the files around it).
 * Offline: no database connection, no network. See docs/ops/catalogue-migration.md.
 */
const USAGE = `Usage: node dist/cli/convert-opencart.js --in <export.json> --out <folder> [--tax <tax-sheet.csv>]
                                                [--language-id 1] [--customer-group-id 1] [--store-id 0] [--prefix oc_]

Writes into <folder>:
  catalog.json      the import file (check it with: npm run import:catalog -- --file <folder>/catalog.json)
  images.json       image paths per product, for: npm run import:images
  redirects.json    old OpenCart ids/keywords -> new addresses (for the go-live 301 redirects)
  tax-review.csv    one row per SKU: fill in gst_rate_percent (0, 0.25, 3, 5, 12, 18, 28, 40) and hsn_code,
                    then run again with --tax <folder>/tax-review.csv
  warnings.txt      everything adjusted or left out
`;

const MAX_EXPORT_BYTES = 200 * 1024 * 1024;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function main(): number {
  const input = arg('in');
  const out = arg('out');
  if (!input || !out) {
    process.stderr.write(USAGE);
    return 2;
  }
  if (statSync(input).size > MAX_EXPORT_BYTES) {
    process.stderr.write(
      'The export is larger than 200 MB: export only the catalogue tables\n',
    );
    return 2;
  }
  let tax;
  const taxPath = arg('tax');
  if (taxPath) {
    const sheet = parseTaxSheet(readFileSync(taxPath, 'utf8'));
    if (sheet.problems.length) {
      process.stderr.write(
        `The tax sheet has ${sheet.problems.length} problem(s):\n${sheet.problems.map((p) => `  - ${p}`).join('\n')}\n`,
      );
      return 1;
    }
    tax = sheet.tax;
  }
  const tables = readPhpMyAdminJson(
    JSON.parse(readFileSync(input, 'utf8')),
    arg('prefix') ?? 'oc_',
  );
  // "today" for sale-price dates, as an India calendar day
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
  }).format(new Date());
  const r = convertOpenCart(tables, {
    today,
    languageId: arg('language-id') ?? '1',
    customerGroupId: arg('customer-group-id') ?? '1',
    storeId: arg('store-id') ?? '0',
    ...(tax ? { tax } : {}),
  });

  mkdirSync(out, { recursive: true });
  writeFileSync(
    join(out, 'catalog.json'),
    `${JSON.stringify(r.file, null, 2)}\n`,
  );
  writeFileSync(
    join(out, 'images.json'),
    `${JSON.stringify(r.images, null, 2)}\n`,
  );
  writeFileSync(
    join(out, 'redirects.json'),
    `${JSON.stringify(r.redirects, null, 2)}\n`,
  );
  writeFileSync(
    join(out, 'tax-review.csv'),
    toCsv(TAX_SHEET_COLUMNS, r.taxSheet),
  );
  writeFileSync(
    join(out, 'warnings.txt'),
    r.warnings.length ? `${r.warnings.join('\n')}\n` : 'No warnings.\n',
  );

  const parsed = parseImportFile(r.file);
  const untaxed = r.taxSheet.filter((row) => !row[2]).length;
  process.stdout.write(
    [
      `Categories: ${r.file.categories.length}, products: ${r.file.products.length}, products with images: ${r.images.length}`,
      `Warnings: ${r.warnings.length} (see warnings.txt)`,
      untaxed
        ? `GST rate still missing for ${untaxed} SKU(s): fill tax-review.csv (the importer would use 18%)`
        : 'Every SKU has a GST rate.',
      parsed.ok
        ? 'The import file is valid.'
        : `The import file has ${parsed.issues.length} problem(s):`,
      ...(parsed.ok
        ? []
        : parsed.issues.map((i) => `  - ${i.path}: ${i.message}`)),
      '',
    ].join('\n'),
  );
  return parsed.ok ? 0 : 1;
}

process.exitCode = main();
