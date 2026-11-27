import { readFileSync } from 'node:fs';
import { checkLaunchConfig, parseEnvFile } from '../common/launch-config.js';

/**
 * Usage: node dist/cli/check-launch-config.js --frontend-env <frontend/.env.production> [--backend-env <.env>]
 * Without --backend-env the backend values come from this process's environment. Prints problems only (never values).
 */
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const fe = arg('frontend-env');
if (!fe) {
  process.stderr.write(
    'Usage: node dist/cli/check-launch-config.js --frontend-env <file> [--backend-env <file>]\n',
  );
  process.exitCode = 2;
} else {
  const be = arg('backend-env');
  const r = checkLaunchConfig(
    be ? parseEnvFile(readFileSync(be, 'utf8')) : process.env,
    parseEnvFile(readFileSync(fe, 'utf8')),
  );
  for (const e of r.errors) process.stdout.write(`ERROR    ${e}\n`);
  for (const w of r.warnings) process.stdout.write(`WARNING  ${w}\n`);
  process.stdout.write(
    r.errors.length
      ? `\n${r.errors.length} error(s): not ready for launch.\n`
      : '\nNo errors.\n',
  );
  process.exitCode = r.errors.length ? 1 : 0;
}
