import { readFileSync } from 'node:fs';
import { parseEnvFile } from '../common/launch-config.js';

/**
 * Prints the frontend build arguments from an env file, read EXACTLY as `npm run check:launch` reads it (quotes,
 * `export`, inline comments), so the checked values are the baked values. Output: NUL-separated KEY=value pairs, only
 * API_INTERNAL_URL and NEXT_PUBLIC_* (never a server secret). Used by scripts/deploy.sh.
 */
const file = process.argv[2];
if (!file) {
  process.stderr.write(
    'Usage: node dist/cli/frontend-build-args.js <frontend env file>\n',
  );
  process.exitCode = 2;
} else {
  const env = parseEnvFile(readFileSync(file, 'utf8'));
  for (const [key, value] of Object.entries(env))
    if (
      /^(NEXT_PUBLIC_[A-Z0-9_]+|API_INTERNAL_URL)$/.test(key) &&
      value !== undefined
    )
      process.stdout.write(`${key}=${value}\0`);
}
