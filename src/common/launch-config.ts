import { checkGstin } from './india/gst.js';

/**
 * Pre-launch check of the business settings (pure, unit-tested; `npm run check:launch`). The storefront's
 * NEXT_PUBLIC_BUSINESS_* values are baked into the build and the backend's SELLER_* values go on every invoice: they
 * must be filled in, well-formed and AGREE with each other. Errors block the launch; warnings need a decision.
 */
export type Env = Record<string, string | undefined>;

export interface LaunchCheck {
  errors: string[];
  warnings: string[];
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const INDIAN_PHONE = /^\+91[ -]?[6-9]\d{4}[ -]?\d{5}$/;
const v = (env: Env, key: string) => env[key]?.trim() || undefined;

export function checkLaunchConfig(backend: Env, frontend: Env): LaunchCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  const f = (k: string) => v(frontend, `NEXT_PUBLIC_BUSINESS_${k}`);

  for (const k of [
    'LEGAL_NAME',
    'ADDRESS',
    'GSTIN',
    'SELLER_STATE',
    'WEBSITE_URL',
    'SUPPORT_EMAIL',
    'GRIEVANCE_OFFICER_NAME',
    'GRIEVANCE_OFFICER_EMAIL',
  ])
    if (!f(k))
      errors.push(
        `frontend: NEXT_PUBLIC_BUSINESS_${k} is not set (shown on the policy and contact pages)`,
      );
  for (const k of [
    'SUPPORT_PHONE',
    'SUPPORT_HOURS',
    'GRIEVANCE_OFFICER_DESIGNATION',
    'GRIEVANCE_OFFICER_PHONE',
  ])
    if (!f(k))
      warnings.push(
        `frontend: NEXT_PUBLIC_BUSINESS_${k} is not set (left out of the pages)`,
      );
  if (!v(frontend, 'NEXT_PUBLIC_TURNSTILE_SITE_KEY'))
    errors.push(
      'frontend: NEXT_PUBLIC_TURNSTILE_SITE_KEY is not set (no captcha on sign-up and contact forms)',
    );
  for (const k of ['SUPPORT_EMAIL', 'GRIEVANCE_OFFICER_EMAIL'])
    if (f(k) && !EMAIL.test(f(k)!))
      errors.push(
        `frontend: NEXT_PUBLIC_BUSINESS_${k} is not an email address`,
      );
  for (const k of ['SUPPORT_PHONE', 'GRIEVANCE_OFFICER_PHONE'])
    if (f(k) && !INDIAN_PHONE.test(f(k)!))
      warnings.push(
        `frontend: NEXT_PUBLIC_BUSINESS_${k} is not written as +91 98765 43210`,
      );

  const site = f('WEBSITE_URL');
  let origin: string | null = null;
  if (site) {
    try {
      const u = new URL(site);
      if (u.protocol !== 'https:')
        errors.push(
          'frontend: NEXT_PUBLIC_BUSINESS_WEBSITE_URL must use https',
        );
      if (u.pathname !== '/' || u.search || u.hash)
        errors.push(
          'frontend: NEXT_PUBLIC_BUSINESS_WEBSITE_URL must be the bare site address (no path)',
        );
      origin = u.origin;
    } catch {
      errors.push('frontend: NEXT_PUBLIC_BUSINESS_WEBSITE_URL is not a URL');
    }
  }

  // GST: the same registration everywhere, in the state the invoices use
  const gstins = { frontend: f('GSTIN'), backend: v(backend, 'SELLER_GSTIN') };
  if (!gstins.backend)
    errors.push(
      'backend: SELLER_GSTIN is not set (invoices are not tax invoices without it)',
    );
  for (const [side, g] of Object.entries(gstins)) {
    if (!g) continue;
    const r = checkGstin(g);
    if (!r.ok) errors.push(`${side}: the GSTIN ${r.reason}`);
  }
  if (
    gstins.frontend &&
    gstins.backend &&
    gstins.frontend.toUpperCase() !== gstins.backend.toUpperCase()
  )
    errors.push(
      'the GSTIN on the pages (NEXT_PUBLIC_BUSINESS_GSTIN) differs from the one on invoices (SELLER_GSTIN)',
    );
  const states = {
    frontend: f('SELLER_STATE'),
    backend: v(backend, 'SELLER_STATE') ?? 'Tamil Nadu',
  };
  if (states.frontend && states.frontend !== states.backend)
    errors.push(
      `the seller state differs: pages say ${states.frontend}, invoices use ${states.backend}`,
    );
  const g = gstins.backend ? checkGstin(gstins.backend) : null;
  if (g?.ok && g.state && g.state !== states.backend)
    errors.push(
      `SELLER_GSTIN is registered in ${g.state} but SELLER_STATE is ${states.backend}`,
    );

  // the legal name on invoices and pages
  const legal = {
    frontend: f('LEGAL_NAME'),
    backend: v(backend, 'SELLER_LEGAL_NAME'),
  };
  if (!legal.backend || legal.backend === 'Yalli')
    warnings.push(
      'backend: SELLER_LEGAL_NAME is the default "Yalli": set the name exactly as on the GST registration',
    );
  if (legal.frontend && legal.backend && legal.frontend !== legal.backend)
    errors.push(
      'the legal name on the pages differs from the one on invoices (SELLER_LEGAL_NAME)',
    );

  // links in emails must point at the real storefront
  const base = v(backend, 'FRONTEND_BASE_URL');
  if (!base || /localhost|127\.0\.0\.1/.test(base))
    errors.push(
      'backend: FRONTEND_BASE_URL is not the public storefront address (emailed links would be broken)',
    );
  else if (origin && new URL(base).origin !== origin)
    errors.push(
      `backend: FRONTEND_BASE_URL (${base}) is not the website address (${origin})`,
    );
  if (!v(backend, 'SUPPORT_INBOX_EMAIL'))
    warnings.push(
      'backend: SUPPORT_INBOX_EMAIL is not set (contact-form messages are only in the console)',
    );
  if (
    !v(backend, 'FRONTEND_SERVER_KEY') ||
    v(backend, 'FRONTEND_SERVER_KEY') !== v(frontend, 'FRONTEND_SERVER_KEY')
  )
    errors.push(
      'FRONTEND_SERVER_KEY must be set to the same value in both apps',
    );
  return { errors, warnings };
}

/** KEY=value lines (comments and blanks ignored; one level of quotes removed), as in .env files. */
export function parseEnvFile(text: string): Env {
  const env: Env = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(
      line,
    );
    if (!m || line.trim().startsWith('#')) continue;
    env[m[1]!] = m[2]!.replace(/^(['"])(.*)\1$/, '$2');
  }
  return env;
}
