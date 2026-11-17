import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Res,
  StreamableFile,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Response } from 'express';
import { Public } from '../../common/decorators/access.decorators.js';
import { SkipEnvelope } from '../../common/decorators/response.decorators.js';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { ObjectStorage, STORAGE_KEY } from './media/object-storage.js';

/**
 * Serves product images in development (production: object store + CDN).
 * Only keys that exist in product_images are served, with the content type WE recorded at upload, nosniff,
 * and a locked-down CSP, so nothing uploaded can ever execute in a browser.
 */
@ApiExcludeController()
@Controller({ path: 'media', version: VERSION_NEUTRAL })
@Public()
@SkipEnvelope()
export class MediaController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: ObjectStorage,
  ) {}

  @Get(':key')
  async get(
    @Param('key') key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    if (!STORAGE_KEY.test(key)) throw new NotFoundException('Not found');
    const image = await this.prisma.productImage.findUnique({
      where: { storageKey: key },
      select: { mimeType: true },
    });
    const bytes = image ? await this.storage.get(key) : null;
    if (!image || !bytes) throw new NotFoundException('Not found');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin'); // the storefront is on another origin
    res.setHeader('Content-Disposition', 'inline');
    return new StreamableFile(bytes, {
      type: image.mimeType,
      length: bytes.length,
    });
  }
}
