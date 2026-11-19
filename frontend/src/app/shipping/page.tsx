import type { Metadata } from 'next';
import Link from 'next/link';
import { List, PolicyPage, Section, textLink, type PolicySection } from '@/components/PolicyPage';

export const metadata: Metadata = {
  title: 'Shipping & delivery | Yalli',
  description: 'Where Yalli delivers, what delivery costs, how long it takes and how to track your order.',
};

const sections: PolicySection[] = [
  { id: 'where', title: 'Where we deliver' },
  { id: 'cost', title: 'Delivery charges' },
  { id: 'time', title: 'How long it takes' },
  { id: 'steps', title: 'From payment to your door' },
  { id: 'tracking', title: 'Tracking your order' },
  { id: 'problems', title: 'If something goes wrong' },
];

export default function ShippingPage() {
  return (
    <PolicyPage
      title="Shipping & delivery"
      intro="How we send your order, what delivery costs, and how to follow your parcel."
      sections={sections}
    >
      <Section id="where" title="Where we deliver">
        <p>
          We deliver to addresses in India. At checkout you choose a saved address or add a new one, and we check which delivery
          options are available for that state. If none of our delivery options reach your address, checkout tells you so{' '}
          <strong>before</strong> you pay.
        </p>
      </Section>

      <Section id="cost" title="Delivery charges">
        <List>
          <li>
            The delivery charge, if there is one, appears as its own line at checkout and is part of the total you pay. You
            always see it before payment.
          </li>
          <li>
            Some orders ship free, for example above a certain order value. The charge depends on the delivery option you choose
            and your order, and is worked out by our system when you check out, so the figure at checkout is the one that
            counts.
          </li>
          <li>When we offer more than one delivery option for your address, you choose one. We never pick a price for you.</li>
          <li>Product prices already include GST. See the tax invoice for the breakdown.</li>
        </List>
      </Section>

      <Section id="time" title="How long it takes">
        <p>
          Each delivery option shows an expected delivery time in days (for example “3–7 days”). The time starts once your
          payment is confirmed. These are estimates, not promises: festivals, weather, strikes and hard-to-reach areas can add
          time.
        </p>
      </Section>

      <Section id="steps" title="From payment to your door">
        <List ordered>
          <li>You pay online. When the payment is confirmed we send an order confirmation email.</li>
          <li>We pack your order. Its status in My orders changes to “Packing”.</li>
          <li>We hand it to the courier and add the courier’s name and your tracking number. You get a “shipped” email.</li>
          <li>When it is delivered you get a “delivered” email, and you can then review the products you bought.</li>
        </List>
        <p>We send each order as a single shipment, even when it contains several items.</p>
      </Section>

      <Section id="tracking" title="Tracking your order">
        <p>
          Open <Link href="/account/orders" className={textLink}>My orders</Link>, choose the order and look at the tracking
          panel. It lists each update we receive, such as in transit, out for delivery, delivery attempt failed, delivered or
          returned to us. You can also use the tracking number on the courier’s own website.
        </p>
      </Section>

      <Section id="problems" title="If something goes wrong">
        <List>
          <li>
            <strong>Wrong address or phone number.</strong> Contact us straight away with your order number. We will try to
            correct it, but once an order has been packed we may not be able to.
          </li>
          <li>
            <strong>Delivery attempt failed.</strong> The courier will usually try again. If the parcel comes back to us, we
            will get in touch.
          </li>
          <li>
            <strong>Not here by the expected date.</strong> Contact us with your order number and we will chase the courier.
          </li>
          <li>
            <strong>Damaged, faulty or wrong item.</strong> Check the parcel when it arrives, and see{' '}
            <Link href="/returns" className={textLink}>Returns, cancellations &amp; refunds</Link> to ask for a return within 7
            days of delivery.
          </li>
        </List>
        <p>
          Questions? <Link href="/contact" className={textLink}>Contact us</Link> or read the{' '}
          <Link href="/help" className={textLink}>help centre</Link>.
        </p>
      </Section>
    </PolicyPage>
  );
}
