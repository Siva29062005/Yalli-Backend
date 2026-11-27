import { canonicalFor } from '@/lib/site';
import type { Metadata } from 'next';
import Link from 'next/link';
import { SellerDetails } from '@/components/BusinessInfo';
import { BUSINESS } from '@/lib/business';
import { List, POLICY_UPDATED, PolicyPage, Section, textLink, type PolicySection } from '@/components/PolicyPage';

export const metadata: Metadata = {
  ...canonicalFor('/terms'),
  title: 'Terms of use & sale | Yalli',
  description: 'The terms that apply when you use the Yalli website and buy from us.',
};

const sections: PolicySection[] = [
  { id: 'seller', title: 'Who is selling' },
  { id: 'account', title: 'Your account' },
  { id: 'orders', title: 'Orders and prices' },
  { id: 'payment', title: 'Payment' },
  { id: 'delivery', title: 'Delivery, returns and refunds' },
  { id: 'content', title: 'Reviews and your content' },
  { id: 'use', title: 'Using the website' },
  { id: 'liability', title: 'Our responsibility' },
  { id: 'law', title: 'Law and disputes' },
];

export default function TermsPage() {
  return (
    <PolicyPage
      title="Terms of use & sale"
      intro="These terms apply when you browse this website or buy from us. By creating an account or placing an order you agree to them."
      updated={POLICY_UPDATED}
      sections={sections}
    >
      <Section id="seller" title="Who is selling">
        <SellerDetails />
        <p>
          Everything on this website is sold by this single seller. Our{' '}
          <Link href="/privacy" className={textLink}>privacy policy</Link>,{' '}
          <Link href="/shipping" className={textLink}>shipping policy</Link> and{' '}
          <Link href="/returns" className={textLink}>returns policy</Link> are part of these terms.
        </p>
      </Section>

      <Section id="account" title="Your account">
        <List>
          <li>You need an account to place an order. You can fill a cart without one, and it joins your account when you sign in.</li>
          <li>
            You must be an adult able to make a binding contract. If you are under 18, a parent or guardian should place the order.
          </li>
          <li>Give correct details and keep them up to date. Keep your password secret, and turn on two-step verification if you can.</li>
          <li>Tell us at once if you think someone else has used your account. You are responsible for activity on it until you do.</li>
          <li>We may suspend an account to protect customers or the store, for example after signs of fraud or abuse.</li>
        </List>
      </Section>

      <Section id="orders" title="Orders and prices">
        <List>
          <li>All prices are in Indian rupees (₹) and include GST. Any delivery charge is shown separately at checkout before you pay.</li>
          <li>
            When you place an order we hold the items for you for a short time (currently about 30 minutes) while you pay. If
            payment does not complete in that time, the order is released.
          </li>
          <li>
            Your order is <strong>confirmed only when your payment is confirmed</strong>, and we then email you. Until then it is
            a request that we have not yet accepted.
          </li>
          <li>
            Prices and stock can change. We work out your total on our system at checkout, and if something changed since you
            added the item we show you before you pay.
          </li>
          <li>
            If a product was listed at an obvious mistake, such as the wrong price, we may cancel the order and refund you in
            full.
          </li>
          <li>One coupon can be used on a cart, and coupons have their own conditions, such as dates and minimum order value.</li>
          <li>We issue a GST tax invoice for every paid order, and a credit note for every refund against it. You can see both under My orders.</li>
        </List>
      </Section>

      <Section id="payment" title="Payment">
        <p>
          We take payment online only, through Razorpay, using UPI, cards, net banking or wallets. We do not offer cash on
          delivery. Razorpay’s own terms apply to the payment window. We never see or store your full card details.
        </p>
      </Section>

      <Section id="delivery" title="Delivery, returns and refunds">
        <p>
          How and when we deliver is in our <Link href="/shipping" className={textLink}>shipping policy</Link>. Cancellations,
          the 7-day return window and refunds are in our <Link href="/returns" className={textLink}>returns policy</Link>.
          Delivery times are estimates. Ownership of the goods passes to you when they are delivered to you.
        </p>
      </Section>

      <Section id="content" title="Reviews and your content">
        <List>
          <li>Only customers who received a product can review it. Reviews are plain text and are checked before they appear.</li>
          <li>Write honestly about your own experience. No abuse, personal details, advertising or anything unlawful.</li>
          <li>
            You keep your rights to what you write, and you allow us to display it on this website. We may decline or remove a
            review that breaks these rules. Editing a review sends it for checking again.
          </li>
        </List>
      </Section>

      <Section id="use" title="Using the website">
        <List>
          <li>Do not try to break, overload or get around the security of the website, and do not use bots or scrapers on it.</li>
          <li>
            Product photos, text, the logo and the design belong to us or our suppliers. Do not copy or reuse them without
            permission.
          </li>
          <li>We take care over product descriptions and images, but colours on screens can differ and small errors can happen.</li>
        </List>
      </Section>

      <Section id="liability" title="Our responsibility">
        <p>
          We are responsible for goods that are not as described and for the service as the law requires. Nothing in these terms
          limits your rights under the Consumer Protection Act, 2019 or other law, or excludes liability that cannot be excluded.
          Subject to that, we are not liable for indirect losses, or for delays caused by events outside our control such as
          strikes, extreme weather or problems with the banking or courier networks.
        </p>
      </Section>

      <Section id="law" title="Law and disputes">
        <p>
          These terms are governed by the laws of India. Please contact us first at our{' '}
          <Link href="/contact#grievance" className={textLink}>grievance officer</Link> so we can put things right. If that does
          not work, you may approach the consumer commission with jurisdiction over you, or the courts in India. The seller is
          registered in {BUSINESS.sellerState}.
        </p>
        <p>We may update these terms. The date at the top shows the latest version, and orders you have already placed are not affected.</p>
      </Section>
    </PolicyPage>
  );
}
