'use client';

import { useEffect, useRef, useState } from 'react';

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
      s.remove(); // let a retry add a fresh script tag
      reject(new Error('captcha script failed to load'));
    };
    document.head.appendChild(s);
  });
  return loading;
}

export function Captcha({ onToken, action, resetKey = 0 }: { onToken: (token: string | null) => void; action: string; resetKey?: number }) {
  const box = useRef<HTMLDivElement>(null);
  const callback = useRef(onToken);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    callback.current = onToken;
  });

  useEffect(() => {
    if (!TURNSTILE_SITE_KEY) return;
    let id: string | undefined;
    let cancelled = false;
    callback.current(null);
    const fail = () => {
      callback.current(null);
      if (!cancelled) setFailed(true);
    };
    loadTurnstile()
      .then(() => {
        if (cancelled || !box.current) return;
        if (!window.turnstile) {
          // The script answered but did not set up Turnstile: forget it so "try again" loads a fresh copy.
          loading = null;
          document.querySelector(`script[src="${SCRIPT}"]`)?.remove();
          return fail();
        }
        setFailed(false);
        id = window.turnstile.render(box.current, {
          sitekey: TURNSTILE_SITE_KEY,
          action,
          callback: (token: string) => {
            setFailed(false); // Turnstile can recover on its own after an error
            callback.current(token);
          },
          'expired-callback': () => callback.current(null),
          'error-callback': fail,
        });
      })
      .catch(fail);
    return () => {
      cancelled = true;
      if (id) window.turnstile?.remove(id);
    };
  }, [action, resetKey, attempt]);

  if (!TURNSTILE_SITE_KEY) return null;
  return (
    <div role="group" aria-label="Security check" className="space-y-2">
      <div ref={box} className="min-h-[65px]" />
      {failed && (
        <p role="alert" className="text-[13px] text-[#B42318]">
          The security check could not be completed. If you use a content blocker or a strict network, allow
          challenges.cloudflare.com, then{' '}
          <button type="button" className="font-semibold underline" onClick={() => setAttempt((n) => n + 1)}>
            try again
          </button>
          .
        </p>
      )}
    </div>
  );
}
