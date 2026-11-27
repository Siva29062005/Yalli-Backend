import { buildMimeMessage } from './mime.js';

const email = {
  to: 'priya@example.com',
  subject: 'Refund processed for order YL26-000001 — ₹250',
  text: 'Plain text',
  html: '<p>Hello</p>',
  attachments: [
    {
      filename: 'credit-note-CN-2627-000001.html',
      contentType: 'text/html' as const,
      content: '<h1>CN</h1>',
    },
  ],
};
const decode = (b64: string) =>
  Buffer.from(b64.replace(/\r\n/g, ''), 'base64').toString('utf8');

describe('raw MIME for emails with attachments', () => {
  it('has the headers, both bodies and the attachment, base64 encoded', () => {
    let n = 0;
    const mime = buildMimeMessage(
      'Yalli <shop@yalli.in>',
      email,
      () => `b${++n}`,
    );
    expect(mime).toContain('From: Yalli <shop@yalli.in>\r\n');
    expect(mime).toContain('To: priya@example.com\r\n');
    const subject = /Subject: =\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=/.exec(
      mime,
    )![1]!;
    expect(decode(subject)).toBe(email.subject);
    expect(mime).toContain(
      'Content-Type: multipart/mixed; boundary="mixed_b1"',
    );
    expect(mime).toContain(
      'Content-Disposition: attachment; filename="credit-note-CN-2627-000001.html"',
    );
    const parts = mime.split('--mixed_b1');
    expect(decode(parts[2]!.split('\r\n\r\n')[1]!.trim())).toBe('<h1>CN</h1>');
    expect(mime.endsWith('--mixed_b1--\r\n')).toBe(true);
  });

  it('cannot be used to inject headers', () => {
    expect(() =>
      buildMimeMessage('a@b.c', {
        ...email,
        to: 'x@y.z\r\nBcc: all@evil.test',
      }),
    ).toThrow();
    expect(() => buildMimeMessage('a@b.c\nBcc: e@v.il', email)).toThrow();
    expect(() =>
      buildMimeMessage('a@b.c', {
        ...email,
        attachments: [
          { ...email.attachments[0]!, filename: 'x"\r\nBcc: e@v.il' },
        ],
      }),
    ).toThrow();
    const mime = buildMimeMessage('a@b.c', {
      ...email,
      subject: 'Hi\r\nBcc: e@v.il',
    });
    expect(mime).not.toMatch(/^Bcc:/m);
  });

  it('wraps base64 at 76 characters', () => {
    const mime = buildMimeMessage('a@b.c', {
      ...email,
      html: 'x'.repeat(5000),
    });
    for (const line of mime.split('\r\n'))
      expect(line.length).toBeLessThanOrEqual(998);
    expect(mime.split('\r\n').some((l) => l.length === 76)).toBe(true);
  });
});
