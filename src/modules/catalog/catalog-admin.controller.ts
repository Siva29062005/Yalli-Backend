import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { memoryStorage } from 'multer';
import type { z } from 'zod';
import type { AuthPrincipal } from '../../common/auth/auth-principal.js';
import {
  CurrentPrincipal,
  RequirePermissions,
  RequireStepUp,
} from '../../common/decorators/access.decorators.js';
import { RateLimit } from '../../common/decorators/rate-limit.decorator.js';
import { ResponseMessage } from '../../common/decorators/response.decorators.js';
import { Permission } from '../access/permissions.js';
import { requestContext } from '../audit/audit.service.js';
import { CatalogAdminService } from './catalog-admin.service.js';
import {
  adminListSchema,
  brandSchema,
  categorySchema,
  createProductSchema,
  imageMetaSchema,
  updateCategorySchema,
  updateProductSchema,
  updateVariantSchema,
  uuidParam,
  variantSchema,
  type CreateProductDto,
  type UpdateProductDto,
  type UpdateVariantDto,
  type VariantDto,
} from './dto/catalog.schemas.js';
import { MAX_IMAGE_BYTES } from './media/image-validation.js';

/** Catalogue management. Every route: specific permission + MFA step-up (30 min) + per-user rate limit + audit. */
@ApiTags('admin-catalog')
@Controller('admin')
@RequireStepUp(1800)
@RateLimit({
  name: 'admin-catalog',
  limit: 120,
  windowSeconds: 60,
  key: 'principal',
})
export class CatalogAdminController {
  constructor(private readonly admin: CatalogAdminService) {}

  // brands / categories
  @Post('brands')
  @RequirePermissions(Permission.ProductsUpdate)
  createBrand(
    @CurrentPrincipal() a: AuthPrincipal,
    @Body({ schema: brandSchema }) dto: z.infer<typeof brandSchema>,
    @Req() req: Request,
  ) {
    return this.admin.createBrand(a, dto, requestContext(req));
  }

  @Delete('brands/:id')
  @HttpCode(200)
  @RequirePermissions(Permission.ProductsDelete)
  async deleteBrand(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('id', { schema: uuidParam }) id: string,
    @Req() req: Request,
  ): Promise<null> {
    await this.admin.deleteBrand(a, id, requestContext(req));
    return null;
  }

  @Post('categories')
  @RequirePermissions(Permission.ProductsUpdate)
  createCategory(
    @CurrentPrincipal() a: AuthPrincipal,
    @Body({ schema: categorySchema }) dto: z.infer<typeof categorySchema>,
    @Req() req: Request,
  ) {
    return this.admin.createCategory(a, dto, requestContext(req));
  }

  @Patch('categories/:id')
  @RequirePermissions(Permission.ProductsUpdate)
  updateCategory(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('id', { schema: uuidParam }) id: string,
    @Body({ schema: updateCategorySchema })
    dto: z.infer<typeof updateCategorySchema>,
    @Req() req: Request,
  ) {
    return this.admin.updateCategory(a, id, dto, requestContext(req));
  }

  @Delete('categories/:id')
  @HttpCode(200)
  @RequirePermissions(Permission.ProductsDelete)
  async deleteCategory(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('id', { schema: uuidParam }) id: string,
    @Req() req: Request,
  ): Promise<null> {
    await this.admin.deleteCategory(a, id, requestContext(req));
    return null;
  }

  // products
  @Get('products')
  @RequirePermissions(Permission.ProductsRead)
  list(@Query({ schema: adminListSchema }) q: z.infer<typeof adminListSchema>) {
    return this.admin.listProducts(q);
  }

  @Get('products/:id')
  @RequirePermissions(Permission.ProductsRead)
  get(@Param('id', { schema: uuidParam }) id: string) {
    return this.admin.getProduct(id);
  }

  @Post('products')
  @RequirePermissions(Permission.ProductsCreate)
  @ResponseMessage('Product created as a draft')
  create(
    @CurrentPrincipal() a: AuthPrincipal,
    @Body({ schema: createProductSchema }) dto: CreateProductDto,
    @Req() req: Request,
  ) {
    return this.admin.createProduct(a, dto, requestContext(req));
  }

  @Patch('products/:id')
  @RequirePermissions(Permission.ProductsUpdate)
  update(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('id', { schema: uuidParam }) id: string,
    @Body({ schema: updateProductSchema }) dto: UpdateProductDto,
    @Req() req: Request,
  ) {
    return this.admin.updateProduct(a, id, dto, requestContext(req));
  }

  @Post('products/:id/publish')
  @HttpCode(200)
  @RequirePermissions(Permission.ProductsPublish)
  publish(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('id', { schema: uuidParam }) id: string,
    @Req() req: Request,
  ) {
    return this.admin.setStatus(a, id, 'PUBLISHED', requestContext(req));
  }

  @Post('products/:id/unpublish')
  @HttpCode(200)
  @RequirePermissions(Permission.ProductsPublish)
  unpublish(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('id', { schema: uuidParam }) id: string,
    @Req() req: Request,
  ) {
    return this.admin.setStatus(a, id, 'DRAFT', requestContext(req));
  }

  @Post('products/:id/archive')
  @HttpCode(200)
  @RequirePermissions(Permission.ProductsPublish)
  archive(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('id', { schema: uuidParam }) id: string,
    @Req() req: Request,
  ) {
    return this.admin.setStatus(a, id, 'ARCHIVED', requestContext(req));
  }

  @Delete('products/:id')
  @HttpCode(200)
  @RequirePermissions(Permission.ProductsDelete)
  async remove(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('id', { schema: uuidParam }) id: string,
    @Req() req: Request,
  ): Promise<null> {
    await this.admin.deleteProduct(a, id, requestContext(req));
    return null;
  }

  // variants (prices additionally need pricing.update, enforced in the service)
  @Post('products/:id/variants')
  @RequirePermissions(Permission.ProductsUpdate)
  addVariant(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('id', { schema: uuidParam }) id: string,
    @Body({ schema: variantSchema }) dto: VariantDto,
    @Req() req: Request,
  ) {
    return this.admin.addVariant(a, id, dto, requestContext(req));
  }

  @Patch('variants/:id')
  @RequirePermissions(Permission.ProductsUpdate)
  updateVariant(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('id', { schema: uuidParam }) id: string,
    @Body({ schema: updateVariantSchema }) dto: UpdateVariantDto,
    @Req() req: Request,
  ) {
    return this.admin.updateVariant(a, id, dto, requestContext(req));
  }

  @Delete('variants/:id')
  @HttpCode(200)
  @RequirePermissions(Permission.ProductsUpdate)
  async deleteVariant(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('id', { schema: uuidParam }) id: string,
    @Req() req: Request,
  ): Promise<null> {
    await this.admin.deleteVariant(a, id, requestContext(req));
    return null;
  }

  // images
  @Post('products/:id/images')
  @RequirePermissions(Permission.ProductsUpdate)
  @RateLimit({
    name: 'image-upload',
    limit: 60,
    windowSeconds: 3_600,
    key: 'principal',
  })
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: MAX_IMAGE_BYTES, files: 1, fields: 4, parts: 5 },
    }),
  )
  upload(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('id', { schema: uuidParam }) id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body({ schema: imageMetaSchema }) meta: z.infer<typeof imageMetaSchema>,
    @Req() req: Request,
  ) {
    return this.admin.uploadImage(a, id, file, meta, requestContext(req));
  }

  @Delete('images/:id')
  @HttpCode(200)
  @RequirePermissions(Permission.ProductsUpdate)
  async deleteImage(
    @CurrentPrincipal() a: AuthPrincipal,
    @Param('id', { schema: uuidParam }) id: string,
    @Req() req: Request,
  ): Promise<null> {
    await this.admin.deleteImage(a, id, requestContext(req));
    return null;
  }
}
