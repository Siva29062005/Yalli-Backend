export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export type ImageType =
  | { mime: 'image/jpeg'; ext: 'jpg' }
  | { mime: 'image/png'; ext: 'png' }
  | { mime: 'image/webp'; ext: 'webp' };

/**
 * Identifies an image by its MAGIC BYTES. The client's filename and declared Content-Type are ignored entirely,
 * so a renamed .html/.svg/.exe cannot be stored as an "image". SVG is deliberately not accepted (it can carry script).
 */
export function detectImageType(bytes: Buffer): ImageType | null {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return { mime: 'image/jpeg', ext: 'jpg' };
  if (
    bytes
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return { mime: 'image/png', ext: 'png' };
  if (
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  )
    return { mime: 'image/webp', ext: 'webp' };
  return null;
}
