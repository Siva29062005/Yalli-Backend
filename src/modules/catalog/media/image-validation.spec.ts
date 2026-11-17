import { detectImageType } from './image-validation.js';
import { STORAGE_KEY } from './object-storage.js';

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(16),
]);
const jpg = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.alloc(16),
]);
const webp = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.alloc(4),
  Buffer.from('WEBP'),
  Buffer.alloc(8),
]);

describe('detectImageType', () => {
  it('recognises real JPEG / PNG / WebP signatures', () => {
    expect(detectImageType(png)?.mime).toBe('image/png');
    expect(detectImageType(jpg)?.mime).toBe('image/jpeg');
    expect(detectImageType(webp)?.mime).toBe('image/webp');
  });
  it.each([
    ['HTML', Buffer.from('<html><script>alert(1)</script></html>')],
    [
      'SVG',
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      ),
    ],
    [
      'Windows executable',
      Buffer.concat([Buffer.from('MZ'), Buffer.alloc(30)]),
    ],
    [
      'ELF binary',
      Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(30)]),
    ],
    ['PDF', Buffer.from('%PDF-1.7 ........')],
    ['GIF (not accepted)', Buffer.from('GIF89a..........')],
    ['empty', Buffer.alloc(0)],
    [
      'RIFF that is not WebP (e.g. WAV)',
      Buffer.concat([
        Buffer.from('RIFF'),
        Buffer.alloc(4),
        Buffer.from('WAVE'),
        Buffer.alloc(8),
      ]),
    ],
  ])('rejects %s', (_n, bytes) => {
    expect(detectImageType(bytes)).toBeNull();
  });
});

describe('storage keys', () => {
  it('only accept server-generated uuid.ext keys', () => {
    expect(STORAGE_KEY.test('0190a7c0-1111-7000-8000-000000000000.png')).toBe(
      true,
    );
    for (const bad of [
      '../etc/passwd',
      '..%2f..%2fx.png',
      'a/b.png',
      '0190a7c0-1111-7000-8000-000000000000.svg',
      '0190a7c0-1111-7000-8000-000000000000.png/../x',
      '',
    ]) {
      expect(STORAGE_KEY.test(bad)).toBe(false);
    }
  });
});
