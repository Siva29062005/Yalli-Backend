import { ConflictException, NotFoundException } from '@nestjs/common';

export class InsufficientStockException extends ConflictException {
  constructor(readonly variantId: string) {
    super({
      message: 'Not enough stock for one or more items',
      code: 'INSUFFICIENT_STOCK',
      issues: [{ path: ['variantId'], message: variantId }],
    });
  }
}

export class ReservationExpiredException extends ConflictException {
  constructor() {
    super({
      message: 'The stock reservation has expired',
      code: 'RESERVATION_EXPIRED',
    });
  }
}

export class ReservationNotFoundException extends NotFoundException {
  constructor() {
    super({
      message: 'No active reservation for this reference',
      code: 'NOT_FOUND',
    });
  }
}
