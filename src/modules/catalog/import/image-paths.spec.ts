import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveInside } from './image-paths.js';

describe('image paths from the manifest stay inside the image folder', () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'yalli-img-')));
  const root = join(base, 'image');
  mkdirSync(join(root, 'catalog'), { recursive: true });
  writeFileSync(join(root, 'catalog', 'momo.jpg'), 'x');
  writeFileSync(join(base, 'secret.txt'), 'top secret');
  symlinkSync(join(base, 'secret.txt'), join(root, 'catalog', 'link.jpg'));
  writeFileSync(
    join(root, 'catalog', 'big.jpg'),
    Buffer.alloc(5 * 1024 * 1024 + 1),
  );

  it('finds a normal file', () => {
    expect(resolveInside(root, 'catalog/momo.jpg')).toEqual({
      file: join(root, 'catalog', 'momo.jpg'),
    });
  });
  it('refuses traversal, absolute paths, NUL bytes and links out of the folder', () => {
    expect(resolveInside(root, '../secret.txt')).toEqual({
      error: 'unsafe path',
    });
    expect(resolveInside(root, 'catalog/../../secret.txt')).toEqual({
      error: 'unsafe path',
    });
    expect(resolveInside(root, join(base, 'secret.txt'))).toEqual({
      error: 'unsafe path',
    });
    expect(resolveInside(root, 'catalog/momo.jpg\u0000')).toEqual({
      error: 'unsafe path',
    });
    expect(resolveInside(root, 'catalog/link.jpg')).toEqual({
      error: 'outside the image folder',
    });
  });
  it('reports missing, non-file and oversized entries', () => {
    expect(resolveInside(root, 'catalog/nope.jpg')).toEqual({
      error: 'file not found',
    });
    expect(resolveInside(root, 'catalog')).toEqual({ error: 'not a file' });
    expect(resolveInside(root, 'catalog/big.jpg')).toEqual({
      error: 'larger than 5 MB',
    });
  });
});
