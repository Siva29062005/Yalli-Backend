import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { isAbsolute, join, sep } from 'node:path';
import { MAX_IMAGE_BYTES } from '../media/image-validation.js';

/**
 * The file inside `root` (a realpath) for a path from the image manifest, or why it is refused: absolute paths, ".."
 * segments, NUL bytes and links that lead outside `root` are refused, as are non-files and files over 5 MB.
 */
export function resolveInside(
  root: string,
  path: string,
): { file: string } | { error: string } {
  if (
    path.includes('\0') ||
    isAbsolute(path) ||
    path.split(/[\\/]/).includes('..')
  )
    return { error: 'unsafe path' };
  let file: string;
  try {
    file = realpathSync(join(root, path));
  } catch {
    return { error: 'file not found' };
  }
  if (!file.startsWith(root + sep))
    return { error: 'outside the image folder' };
  const st = statSync(file);
  if (!st.isFile()) return { error: 'not a file' };
  if (st.size > MAX_IMAGE_BYTES) return { error: 'larger than 5 MB' };
  return { file };
}

/**
 * Reads a file found by `resolveInside` WITHOUT following a link at its last component, so a file swapped for a link
 * after the check is refused instead of read; the size limit is checked again on the opened file.
 */
export function readNoFollow(file: string): Buffer {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > MAX_IMAGE_BYTES)
      throw new Error('not a readable image file');
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}
