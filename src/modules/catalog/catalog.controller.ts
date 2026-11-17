import { Controller, Get, Header, Param, Query } from '@nestjs/common';
import { z } from 'zod';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/decorators/access.decorators.js';
import { RateLimit } from '../../common/decorators/rate-limit.decorator.js';
import { CatalogQueryService } from './catalog-query.service.js';
import {
  listProductsSchema,
  slugParam,
  type ListProductsQuery,
} from './dto/catalog.schemas.js';

const compareQuery = z
  .object({
    slugs: z
      .string()
      .max(700)
      .transform((v) => [...new Set(v.split(',').map((s) => s.trim()))])
      .pipe(z.array(slugParam).min(2).max(4)),
  })
  .strict();

/** Public storefront catalogue (read-only, published products only). */
@ApiTags('catalog')
@Controller('catalog')
@Public()
export class CatalogController {
  constructor(private readonly catalog: CatalogQueryService) {}

  // Search/listing is the most expensive public query and its cache is bypassed by varying `q`: give it its own, tighter budget.
  @Get('products')
  @RateLimit({ name: 'catalog-list', limit: 120, windowSeconds: 60, key: 'ip' })
  @Header('Cache-Control', 'public, max-age=30')
  list(@Query({ schema: listProductsSchema }) query: ListProductsQuery) {
    return this.catalog.listProducts(query);
  }

  /** `GET /catalog/compare?slugs=a,b,c` - 2 to 4 distinct products. */
  @Get('compare')
  @RateLimit({
    name: 'catalog-compare',
    limit: 60,
    windowSeconds: 60,
    key: 'ip',
  })
  @Header('Cache-Control', 'public, max-age=30')
  compare(@Query({ schema: compareQuery }) q: z.infer<typeof compareQuery>) {
    return this.catalog.compare(q.slugs);
  }

  @Get('products/:slug')
  @Header('Cache-Control', 'public, max-age=30')
  product(@Param('slug', { schema: slugParam }) slug: string) {
    return this.catalog.getProduct(slug);
  }

  @Get('categories')
  @Header('Cache-Control', 'public, max-age=60')
  categories() {
    return this.catalog.categoryTree();
  }

  @Get('brands')
  @Header('Cache-Control', 'public, max-age=60')
  brands() {
    return this.catalog.brands();
  }
}
