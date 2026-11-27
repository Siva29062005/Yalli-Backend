import sharp from 'sharp';
import {
  ImageRejected,
  MAX_IMAGE_SIDE,
  reencodeImage,
} from './image-processing.js';

const JPEG = { mime: 'image/jpeg', ext: 'jpg' } as const;
const PNG = { mime: 'image/png', ext: 'png' } as const;

/** A phone-style photo: EXIF with a camera, a GPS position and "rotate 90°" (orientation 6), 40 x 20 px stored. */
async function phonePhoto(): Promise<Buffer> {
  return sharp({
    create: { width: 40, height: 20, channels: 3, background: '#c33' },
  })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .withExifMerge({
      IFD0: { Make: 'PhoneCo', Model: 'X1' },
      IFD3: {
        GPSLatitudeRef: 'N',
        GPSLatitude: '9/1 55/1 0/1',
        GPSLongitudeRef: 'E',
        GPSLongitude: '78/1 7/1 0/1',
      },
    })
    .toBuffer();
}

describe('image re-encoding', () => {
  it('drops EXIF (camera, GPS) after turning the pixels upright', async () => {
    const original = await phonePhoto();
    const before = await sharp(original).metadata();
    expect(before.exif).toBeDefined();
    expect(before.orientation).toBe(6);
    const clean = await reencodeImage(original, JPEG);
    const after = await sharp(clean).metadata();
    expect(after.format).toBe('jpeg');
    expect(after.exif).toBeUndefined();
    expect(after.orientation).toBeUndefined();
    expect(after.icc).toBeUndefined();
    expect([after.width, after.height]).toEqual([20, 40]); // rotated by the EXIF orientation
    expect(clean.includes(Buffer.from('PhoneCo'))).toBe(false);
  });

  it('removes data hidden after the image and text chunks, keeps the format', async () => {
    const png = await sharp({
      create: { width: 8, height: 8, channels: 4, background: '#0a0' },
    })
      .png()
      .withMetadata({})
      .toBuffer();
    const smuggled = Buffer.concat([
      png,
      Buffer.from('<script>alert(1)</script>'),
    ]);
    const clean = await reencodeImage(smuggled, PNG);
    expect((await sharp(clean).metadata()).format).toBe('png');
    expect(clean.includes(Buffer.from('<script>'))).toBe(false);
  });

  it('scales big photos down to fit, never up', async () => {
    const big = await sharp({
      create: { width: 4000, height: 1000, channels: 3, background: '#fff' },
    })
      .jpeg()
      .toBuffer();
    const meta = await sharp(await reencodeImage(big, JPEG)).metadata();
    expect([meta.width, meta.height]).toEqual([MAX_IMAGE_SIDE, 600]);
    const small = await sharp({
      create: { width: 10, height: 10, channels: 3, background: '#fff' },
    })
      .jpeg()
      .toBuffer();
    expect(
      (await sharp(await reencodeImage(small, JPEG)).metadata()).width,
    ).toBe(10);
  });

  it('refuses a damaged file and a decompression bomb', async () => {
    const jpeg = await phonePhoto();
    await expect(
      reencodeImage(jpeg.subarray(0, 60), JPEG),
    ).rejects.toBeInstanceOf(ImageRejected);
    const bomb = await sharp({
      create: { width: 8000, height: 6000, channels: 3, background: '#000' },
    })
      .png()
      .toBuffer();
    expect(bomb.length).toBeLessThan(5 * 1024 * 1024); // small on disk…
    await expect(reencodeImage(bomb, PNG)).rejects.toBeInstanceOf(
      ImageRejected,
    ); // …48 million pixels decoded
  });
});
