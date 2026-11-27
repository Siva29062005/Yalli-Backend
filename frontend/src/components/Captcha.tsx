'use client';

import { useEffect, useRef } from 'react';

/**
 * Cloudflare Turnstile. The backend requires a token on sign-up and forgot-password in production
 * (CAPTCHA_PROVIDER=turnstile). With no NEXT_PUBLIC_TURNSTILE_SITE_KEY (development, CAPTCHA_PROVIDER=none) nothing is
 * rendered and no token is sent. Tokens are single-use: change `resetKey` after every submit to get a fresh one.
 * Cloudflare test keys: site 1x00000000000000000000AA / secret 1x0000000000000000000000000000000AA (always pass).
 */
export const TURNSTILE_SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY?.trim() || undefined;
export const captchaRequired = TURNSTILE_SITE_KEY !== undefined;

const SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

interface TurnstileApi {
  render(el: HTMLElement, opts: Record<string, unknown>): string;
  remove(id: string): void;
}
declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let loading: Promise<void> | null = null;
function loadTurnstile(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  loading ??= new Promise<void>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = SCRIPT;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      loading = null;
      reject(new Error('captcha script failed to load'));
    };
    document.head.appendChild(s);
  });
  return loading;
}

export function Captcha({ onToken, action, resetKey = 0 }: { onToken: (token: string | null) => void; action: string; resetKey?: number }) {
  const box = useRef<HTMLDivElement>(null);
  const callback = useRef(onToken);
  useEffect(() => {
    callback.current = onToken;
  });

  useEffect(() => {
    if (!TURNSTILE_SITE_KEY) return;
    let id: string | undefined;
    let cancelled = false;
    callback.current(null);
    loadTurnstile()
      .then(() => {
        if (cancelled || !box.current || !window.turnstile) return;
        id = window.turnstile.render(box.current, {
          sitekey: TURNSTILE_SITE_KEY,
          action,
          callback: (token: string) => callback.current(token),
          'expired-callback': () => callback.current(null),
          'error-callback': () => callback.current(null),
        });
      })
      .catch(() => callback.current(null));
    return () => {
      cancelled = true;
      if (id) window.turnstile?.remove(id);
    };
  }, [action, resetKey]);

  if (!TURNSTILE_SITE_KEY) return null;
  return <div ref={box} className="min-h-[65px]" aria-label="Security check" />;
}
