import sharp from 'sharp';
import { MAX_IMAGE_BYTES, type ImageType } from './image-validation.js';

/** Larger photos are scaled down to fit this box (product galleries never show more). */
export const MAX_IMAGE_SIDE = 2400;
/**
 * Decoded size limit: refuses "decompression bombs" (a small file that expands to many pixels). 25 megapixels is a
 * 6000 x 4000 photo, more than enough for a 2400 px result.
 */
const MAX_INPUT_PIXELS = 25_000_000;

// One libvips thread per image and one image at a time: decoding is memory- and CPU-heavy, and the libuv threadpool it
// runs on is shared with password hashing (logins must not wait behind a batch of uploads).
sharp.concurrency(1);
let queue: Promise<unknown> = Promise.resolve();
function oneAtATime<T>(work: () => Promise<T>): Promise<T> {
  const run = queue.then(work, work);
  queue = run.catch(() => undefined);
  return run;
}

export class ImageRejected extends Error {}

/**
 * Re-encodes an uploaded image (already identified by its magic bytes) in the SAME format:
 *  - every piece of metadata is dropped (EXIF with camera GPS position, XMP, IPTC, ICC, embedded thumbnails, text chunks),
 *    after the EXIF orientation is applied to the pixels so the photo stays upright;
 *  - the result is a fresh file written by libvips, so anything appended to or hidden in the original does not survive;
 *  - large photos are scaled to fit MAX_IMAGE_SIDE; only the first frame of an animation is kept;
 *  - the result stays within MAX_IMAGE_BYTES (a palette PNG is written as a palette again; if it is still too big the
 *    image is re-encoded more compactly once, then refused).
 * A file libvips cannot decode, or one that decodes to more than MAX_INPUT_PIXELS, is refused.
 */
export function reencodeImage(bytes: Buffer, type: ImageType): Promise<Buffer> {
  return oneAtATime(async () => {
    let out: Buffer;
    try {
      const meta = await sharp(bytes, {
        limitInputPixels: MAX_INPUT_PIXELS,
        failOn: 'error',
      }).metadata();
      out = await encode(bytes, type, {
        palette: meta.isPalette === true,
        compact: false,
      });
      if (out.length > MAX_IMAGE_BYTES)
        out = await encode(bytes, type, { palette: true, compact: true });
    } catch {
      throw new ImageRejected('The image could not be read');
    }
    if (out.length > MAX_IMAGE_BYTES)
      throw new ImageRejected('The image is too large even after compression');
    return out;
  });
}

function encode(
  bytes: Buffer,
  type: ImageType,
  opts: { palette: boolean; compact: boolean },
): Promise<Buffer> {
  const pipeline = sharp(bytes, {
    limitInputPixels: MAX_INPUT_PIXELS,
    failOn: 'error',
    animated: false,
  })
    .rotate() // apply the EXIF orientation; the tag is dropped with the rest of the metadata
    .resize({
      width: MAX_IMAGE_SIDE,
      height: MAX_IMAGE_SIDE,
      fit: 'inside',
      withoutEnlargement: true,
    });
  switch (type.mime) {
    case 'image/jpeg':
      return pipeline
        .jpeg({ quality: opts.compact ? 72 : 85, mozjpeg: true })
        .toBuffer();
    case 'image/png':
      return pipeline
        .png({ compressionLevel: 9, palette: opts.palette })
        .toBuffer();
    case 'image/webp':
      return pipeline.webp({ quality: opts.compact ? 72 : 85 }).toBuffer();
  }
}
