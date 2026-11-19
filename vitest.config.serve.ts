// Opt-in (not part of `npm run check`): serves the REAL application on an isolated embedded PostgreSQL so a browser can
// drive it. Run with `npm run serve:browser`; see test/support/serve-browser.serve-spec.ts.
import { defineConfig } from 'vitest/config';
import base from './vitest.config.e2e.js';

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ['test/support/serve-browser.serve-spec.ts'],
    // Real browsers send bigger bodies than the 1 KB e2e limit (production allows 100 KB).
    env: { ...base.test?.env, REQUEST_BODY_LIMIT_KB: '100' },
  },
});
