import { canonicalFor } from '@/lib/site';
import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { PolicyPage, Section, textLink, type PolicySection } from '@/components/PolicyPage';

export const metadata: Metadata = {
  ...canonicalFor('/help'),
  title: 'Help & FAQs | Yalli',
  description: 'Answers about ordering, payment, delivery, returns, refunds and your Yalli account.',
};

const sections: PolicySection[] = [
  { id: 'ordering', title: 'Ordering and payment' },
  { id: 'delivery', title: 'Delivery' },
  { id: 'returns', title: 'Returns and refunds' },
  { id: 'account', title: 'Your account' },
];

function Faq({ q, children }: { q: string; children: ReactNode }) {
  return (
    <details className="group rounded-xl border border-[#E6EAE7] bg-white px-4 py-3 open:shadow-sm">
      <summary className="flex cursor-pointer list-none items-start justify-between gap-3 text-[15px] font-semibold text-[#113322] focus-visible:rounded focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#116644] [&::-webkit-details-marker]:hidden">
        <span className="min-w-0 [overflow-wrap:anywhere]">{q}</span>
        <span aria-hidden="true" className="shrink-0 text-[#116644] transition group-open:rotate-45">+</span>
      </summary>
      <div className="mt-2 space-y-2 text-[15px] leading-relaxed text-[#2F3B35] [overflow-wrap:anywhere]">{children}</div>
    </details>
  );
}

export default function HelpPage() {
  return (
    <PolicyPage
      title="Help & FAQs"
      intro={
        <>
          Quick answers to common questions. Can’t find yours? <Link href="/contact" className={textLink}>Contact us</Link>.
        </>
      }
      sections={sections}
    >
      <Section id="ordering" title="Ordering and payment">
        <div className="space-y-2">
          <Faq q="Do I need an account to order?">
            <p>
              You can browse and fill a cart without one, but you need an account to check out. Your cart joins your account when
              you sign in. <Link href="/auth/register" className={textLink}>Create an account</Link> or{' '}
              <Link href="/auth/login" className={textLink}>sign in</Link>.
            </p>
          </Faq>
          <Faq q="How can I pay?">
            <p>
              Online, through Razorpay: UPI, credit or debit card, net banking or wallet. We do not offer cash on delivery. Your
              card and bank details go to Razorpay and your bank, never to us.
            </p>
          </Faq>
          <Faq q="Are the prices final? What about GST?">
            <p>
              Prices are in rupees and include GST. A delivery charge, if there is one, is shown as a separate line before you pay.
              We issue a GST tax invoice for every paid order, under My orders. A delivery charge includes GST at the rate of the goods it carries.
            </p>
          </Faq>
          <Faq q="How long do I have to pay after placing an order?">
            <p>
              We hold your items for about 30 minutes. If payment is not completed in that time, the order is released and the
              items go back on sale. If a payment fails, you can try again while the order is still open.
            </p>
          </Faq>
          <Faq q="I was charged but I have no order confirmation.">
            <p>
              Please wait a few minutes, as confirmation can take a short while, and do not pay again. If the payment arrives after the order
              expired, we refund it automatically in full to the same payment method. Otherwise{' '}
              <Link href="/contact" className={textLink}>contact us</Link> with your order number and payment time.
            </p>
          </Faq>
          <Faq q="Can I use a coupon?">
            <p>Yes, enter the code in your cart. One coupon applies to a cart, and it may have a minimum order value or an end date.</p>
          </Faq>
        </div>
      </Section>

      <Section id="delivery" title="Delivery">
        <div className="space-y-2">
          <Faq q="How much is delivery and how long does it take?">
            <p>
              Delivery options, their charge (some are free) and the expected days appear at checkout before you pay. See{' '}
              <Link href="/shipping" className={textLink}>Shipping &amp; delivery</Link>.
            </p>
          </Faq>
          <Faq q="How do I track my order?">
            <p>
              Open <Link href="/account/orders" className={textLink}>My orders</Link> and choose the order. You will also get an
              email when it ships, with the courier and tracking number.
            </p>
          </Faq>
          <Faq q="I gave the wrong address.">
            <p>
              <Link href="/contact" className={textLink}>Contact us</Link> straight away. We can only try to change it if the
              order has not been packed yet.
            </p>
          </Faq>
        </div>
      </Section>

      <Section id="returns" title="Returns and refunds">
        <div className="space-y-2">
          <Faq q="Can I cancel my order?">
            <p>
              Yes, until it ships. Cancel from My orders. If you already paid, the full amount is refunded to your original payment
              method. After it ships, you can return it once delivered.
            </p>
          </Faq>
          <Faq q="How do I return something?">
            <p>
              Within 7 days of delivery, open the delivered order in{' '}
              <Link href="/account/orders" className={textLink}>My orders</Link> and choose “Request a return”. Follow the progress
              in <Link href="/account/returns" className={textLink}>My returns</Link>. Full details are in{' '}
              <Link href="/returns" className={textLink}>Returns, cancellations &amp; refunds</Link>.
            </p>
          </Faq>
          <Faq q="When will I get my refund?">
            <p>
              Refunds go back to the payment method you used. After we send it, UPI usually takes 2–7 working days, net banking
              2–10, cards 5–10 and wallets 0–3, but your bank has the final say.
            </p>
          </Faq>
        </div>
      </Section>

      <Section id="account" title="Your account">
        <div className="space-y-2">
          <Faq q="I forgot my password.">
            <p>
              Use <Link href="/auth/reset-password" className={textLink}>Reset password</Link> and we will email you a link.
              Never share the link or any code with anyone.
            </p>
          </Faq>
          <Faq q="I did not get the verification email.">
            <p>
              Check your spam folder, then request a new link on the <Link href="/auth/verify-email" className={textLink}>verify
              email</Link> page.
            </p>
          </Faq>
          <Faq q="How do I make my account safer?">
            <p>
              Turn on two-step verification in{' '}
              <Link href="/account/security/2fa" className={textLink}>Security</Link>, and check{' '}
              <Link href="/account/sessions" className={textLink}>Active sessions</Link> for devices you do not recognise.
            </p>
          </Faq>
          <Faq q="How do I stop offer emails, or delete my account?">
            <p>
              Switch offers off any time in <Link href="/account/profile" className={textLink}>My profile</Link>. To delete your
              account, <Link href="/contact" className={textLink}>contact us</Link>. See our{' '}
              <Link href="/privacy" className={textLink}>privacy policy</Link> for what is kept and removed.
            </p>
          </Faq>
        </div>
      </Section>
    </PolicyPage>
  );
}
