import sharp from 'sharp';
import type { ImageType } from './image-validation.js';

/** Larger photos are scaled down to fit this box (product galleries never show more). */
export const MAX_IMAGE_SIDE = 2400;
/** Decoded size limit: refuses "decompression bombs" (a small file that expands to billions of pixels). */
const MAX_INPUT_PIXELS = 40_000_000;

export class ImageRejected extends Error {}

/**
 * Re-encodes an uploaded image (already identified by its magic bytes) in the SAME format:
 *  - every piece of metadata is dropped (EXIF with camera GPS position, XMP, IPTC, embedded thumbnails, text chunks),
 *    after the EXIF orientation is applied to the pixels so the photo stays upright;
 *  - the result is a fresh file written by libvips, so anything appended to or hidden in the original does not survive;
 *  - large photos are scaled to fit MAX_IMAGE_SIDE; only the first frame of an animation is kept.
 * A file libvips cannot decode, or one that decodes to more than MAX_INPUT_PIXELS, is refused.
 */
export async function reencodeImage(
  bytes: Buffer,
  type: ImageType,
): Promise<Buffer> {
  try {
    const pipeline = sharp(bytes, {
      limitInputPixels: MAX_INPUT_PIXELS,
      failOn: 'error',
      animated: false,
    })
      .rotate() // apply the EXIF orientation, then the orientation tag is dropped with the rest
      .resize({
        width: MAX_IMAGE_SIDE,
        height: MAX_IMAGE_SIDE,
        fit: 'inside',
        withoutEnlargement: true,
      });
    switch (type.mime) {
      case 'image/jpeg':
        return await pipeline.jpeg({ quality: 85, mozjpeg: true }).toBuffer();
      case 'image/png':
        return await pipeline.png({ compressionLevel: 9 }).toBuffer();
      case 'image/webp':
        return await pipeline.webp({ quality: 85 }).toBuffer();
    }
  } catch {
    throw new ImageRejected('The image could not be read');
  }
}
