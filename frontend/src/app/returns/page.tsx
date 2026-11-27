import { canonicalFor } from '@/lib/site';
import type { Metadata } from 'next';
import Link from 'next/link';
import { List, POLICY_UPDATED, PolicyPage, Section, textLink, type PolicySection } from '@/components/PolicyPage';

export const metadata: Metadata = {
  ...canonicalFor('/returns'),
  title: 'Returns, cancellations & refunds | Yalli',
  description: 'How to cancel an order, return an item within 7 days of delivery, and when and how refunds reach you.',
};

const sections: PolicySection[] = [
  { id: 'cancel', title: 'Cancelling an order' },
  { id: 'returns', title: 'Returning an item' },
  { id: 'how', title: 'How to ask for a return' },
  { id: 'refunds', title: 'How refunds work' },
  { id: 'timing', title: 'How long a refund takes' },
  { id: 'payments', title: 'Payment problems' },
  { id: 'rights', title: 'Your rights' },
];

export default function ReturnsPage() {
  return (
    <PolicyPage
      title="Returns, cancellations & refunds"
      intro="What you can cancel or return, how to do it, and how your money comes back."
      updated={POLICY_UPDATED}
      sections={sections}
    >
      <Section id="cancel" title="Cancelling an order">
        <List>
          <li>
            <strong>Not paid yet.</strong> You can cancel from My orders at any time. Items and any coupon are released. An
            unpaid order is also released automatically when its payment time runs out (currently about 30 minutes).
          </li>
          <li>
            <strong>Paid, not shipped yet.</strong> While the order is “Confirmed” or “Packing” you can cancel it from My
            orders. We refund the <strong>full amount you paid</strong>, including any delivery charge, to your original
            payment method.
          </li>
          <li>
            <strong>Already shipped.</strong> It can no longer be cancelled. When it arrives you can return it as described
            below.
          </li>
        </List>
      </Section>

      <Section id="returns" title="Returning an item">
        <List>
          <li>
            <strong>7 days.</strong> You can ask for a return within <strong>7 days of delivery</strong>. Only delivered orders
            can be returned.
          </li>
          <li>
            <strong>Reasons we accept.</strong> The item arrived damaged or not working; it stopped working (faulty); we sent the
            wrong item; you ordered by mistake; or another reason you describe. For “faulty” and “other” please tell us what is
            wrong.
          </li>
          <li>
            <strong>Opened or unopened.</strong> You tell us whether the item has been opened. Please keep the product and its
            packaging as complete as you can.
          </li>
          <li>You can return up to the number of units you bought, and have one open return request per order at a time.</li>
          <li>
            We refund returns. We do not currently offer replacements or exchanges through the website. If you would like one,
            <Link href="/contact" className={textLink}> contact us</Link> first.
          </li>
        </List>
      </Section>

      <Section id="how" title="How to ask for a return">
        <List ordered>
          <li>
            Sign in and open <Link href="/account/orders" className={textLink}>My orders</Link>, choose the delivered order and
            choose “Request a return”.
          </li>
          <li>Pick the item and quantity, the reason, whether it was opened, and add details.</li>
          <li>
            Our team reviews your request and approves or declines it. You see the decision in{' '}
            <Link href="/account/returns" className={textLink}>My returns</Link> and by email, with a note from us when we have
            one.
          </li>
          <li>If approved, we tell you how to send the item back. Once we have received it we raise your refund.</li>
        </List>
      </Section>

      <Section id="refunds" title="How refunds work">
        <List>
          <li>
            <strong>Original payment method only.</strong> Refunds go back to the card, UPI ID, bank account or wallet you paid
            with. We cannot send money anywhere else.
          </li>
          <li>
            <strong>Amount.</strong> For a return, we refund what you paid for the returned items, after any coupon discount. We
            may agree a different amount with you in special cases. Delivery charges are refunded when an order is cancelled
            before it ships.
          </li>
          <li>
            <strong>Checked first.</strong> Refunds raised by our team are approved by a second person before the money is sent.
            Refunds for orders you cancel before shipping are started automatically.
          </li>
          <li>You get an email when your refund has been processed, and a credit note for it appears next to the invoice in My orders.</li>
        </List>
      </Section>

      <Section id="timing" title="How long a refund takes">
        <p>
          Once we have sent the refund, the time it takes to appear depends on your bank or wallet. These are the usual ranges
          published by our payment provider, Razorpay, in working days:
        </p>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[280px] text-left text-[14px]">
            <caption className="sr-only">Usual refund times by payment method</caption>
            <thead>
              <tr className="border-b border-[#DCE3DE] text-[#4A5550]">
                <th scope="col" className="py-2 pr-4 font-semibold">Paid with</th>
                <th scope="col" className="py-2 font-semibold">Usually shows up in</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#E6EAE7]">
              <tr><th scope="row" className="py-2 pr-4 font-normal">Credit or debit card</th><td className="py-2">5–10 working days</td></tr>
              <tr><th scope="row" className="py-2 pr-4 font-normal">Net banking</th><td className="py-2">2–10 working days</td></tr>
              <tr><th scope="row" className="py-2 pr-4 font-normal">UPI</th><td className="py-2">2–7 working days</td></tr>
              <tr><th scope="row" className="py-2 pr-4 font-normal">Wallet</th><td className="py-2">0–3 working days</td></tr>
            </tbody>
          </table>
        </div>
        <p>
          Banks sometimes take longer than these ranges, and we cannot speed that part up. If your refund email is more than 10
          working days old and you still see nothing, <Link href="/contact" className={textLink}>contact us</Link> with your
          order number.
        </p>
      </Section>

      <Section id="payments" title="Payment problems">
        <List>
          <li>
            <strong>Money taken but no order.</strong> If your payment goes through after the order has expired or been
            cancelled, we refund it in full to the same payment method automatically.
          </li>
          <li>
            <strong>Payment failed.</strong> If the payment fails you can try again while the order is still open. Any amount a
            bank holds on a failed payment is normally released by the bank.
          </li>
        </List>
      </Section>

      <Section id="rights" title="Your rights">
        <p>
          This policy does not take away any right you have under the Consumer Protection Act, 2019 or any other Indian law. If
          you are not happy with how we handled something, see our{' '}
          <Link href="/contact#grievance" className={textLink}>grievance officer details</Link>.
        </p>
      </Section>
    </PolicyPage>
  );
}
