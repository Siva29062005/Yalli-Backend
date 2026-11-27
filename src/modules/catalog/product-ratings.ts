import { Injectable } from '@nestjs/common';

export interface ProductRating {
  /** One decimal, or null when there are no approved reviews. */
  average: number | null;
  count: number;
}

/** Implemented by the reviews module, which owns the review data. */
export interface ProductRatingSource {
  ratingsFor(
    productIds: readonly string[],
  ): Promise<Map<string, ProductRating>>;
}

const NONE: ProductRating = { average: null, count: 0 };

/**
 * Inversion point so the catalogue can show ratings without reading the reviews module's tables (the reviews module
 * depends on the catalogue, so the catalogue cannot import it). The reviews module registers itself on start-up.
 */
@Injectable()
export class ProductRatings {
  private source: ProductRatingSource | null = null;

  register(source: ProductRatingSource): void {
    if (this.source && this.source !== source)
      throw new Error('A product rating source is already registered');
    this.source = source;
  }

  /** Every requested id gets an entry; products without approved reviews (or with no source) get no rating. */
  async forProducts(
    productIds: readonly string[],
  ): Promise<Map<string, ProductRating>> {
    const found =
      this.source && productIds.length > 0
        ? await this.source.ratingsFor(productIds)
        : new Map<string, ProductRating>();
    return new Map(productIds.map((id) => [id, found.get(id) ?? NONE]));
  }
}
