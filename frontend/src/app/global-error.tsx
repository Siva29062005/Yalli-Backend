'use client';

/**
 * Replaces the whole document when the root layout itself fails, so it must bring its own <html>, <body> and styles.
 * No error text is shown.
 */
export default function GlobalError({ retry }: { error: unknown; retry: () => void }) {
  return (
    <html lang="en">
      <head>
        <title>Something went wrong | Yalli</title>
      </head>
      <body style={{ margin: 0, fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif', background: '#FAFAFA', color: '#113322' }}>
        <main role="alert" style={{ maxWidth: 520, margin: '0 auto', padding: '96px 16px', textAlign: 'center' }}>
          <h1 style={{ fontSize: 28, margin: '0 0 12px' }}>Something went wrong</h1>
          <p style={{ fontSize: 15, color: '#4A5550', margin: '0 0 24px' }}>
            We couldn’t load the store just now. Please try again in a moment.
          </p>
          <button
            type="button"
            onClick={() => retry()}
            style={{ background: '#116644', color: '#fff', border: 0, borderRadius: 12, padding: '12px 24px', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}
          >
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
