import { Module } from '@nestjs/common';
import { CartModule } from '../cart/cart.module.js';
import { CheckoutService } from '../checkout/checkout.service.js';
import { CouponsModule } from '../coupons/coupons.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { InventoryModule } from '../inventory/inventory.module.js';
import { PaymentProvider } from '../payments/payment-provider.js';
import { PaymentService } from '../payments/payment.service.js';
import {
  FetchRazorpayHttp,
  RazorpayAdapter,
  RazorpayHttp,
} from '../payments/razorpay.adapter.js';
import { RefundService } from '../refunds/refund.service.js';
import { ShippingModule } from '../shipping/shipping.module.js';
import { AnalyticsController } from './analytics.controller.js';
import { AnalyticsService } from './analytics.service.js';
import { CommerceWorker } from './commerce-worker.js';
import {
  AdminOrdersController,
  AdminRefundsController,
  AdminCreditNotesController,
  CheckoutController,
  OrdersController,
  WebhooksController,
} from './commerce.controllers.js';
import { CreditNoteConsumer } from './credit-note.consumer.js';
import { CreditNoteService } from './credit-note.service.js';
import { OrderEventsConsumer } from './order-events.consumer.js';
import { OrderLifecycleService } from './order-lifecycle.service.js';
import { OrderViewService } from './order-view.service.js';
import { OrderService } from './order.service.js';
import { ReturnService } from './return.service.js';

/**
 * Checkout, orders, payments, refunds and returns live in ONE module on purpose: they form a single transactional
 * unit (an order, its payment and its refunds change together), so splitting them would only create circular imports.
 * The payment provider and its HTTP transport are replaceable ports.
 */
@Module({
  imports: [
    InventoryModule,
    CouponsModule,
    CartModule,
    IdentityModule,
    ShippingModule,
  ],
  controllers: [
    CheckoutController,
    OrdersController,
    WebhooksController,
    AdminOrdersController,
    AdminRefundsController,
    AdminCreditNotesController,
    AnalyticsController,
  ],
  providers: [
    OrderLifecycleService,
    OrderViewService,
    OrderService,
    ReturnService,
    CheckoutService,
    PaymentService,
    RefundService,
    CommerceWorker,
    AnalyticsService,
    OrderEventsConsumer,
    CreditNoteService,
    CreditNoteConsumer,
    { provide: RazorpayHttp, useClass: FetchRazorpayHttp },
    { provide: PaymentProvider, useClass: RazorpayAdapter },
  ],
  exports: [OrderService, PaymentService, RefundService, CommerceWorker],
})
export class CommerceModule {}
