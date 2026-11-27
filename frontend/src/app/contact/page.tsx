import { canonicalFor } from '@/lib/site';
import type { Metadata } from 'next';
import Link from 'next/link';
import { GrievanceOfficer, SellerDetails, SupportDetails } from '@/components/BusinessInfo';
import { PolicyPage, Section, textLink } from '@/components/PolicyPage';

export const metadata: Metadata = {
  ...canonicalFor('/contact'),
  title: 'Contact us | Yalli',
  description: 'How to reach Yalli customer support, seller details and our grievance officer.',
};

export default function ContactPage() {
  return (
    <PolicyPage title="Contact us" intro="We are happy to help with an order, a return, your account or anything else.">
      <Section id="support" title="Customer support">
        <SupportDetails />
        <p>To help us find your order quickly, please include:</p>
        <ul className="list-disc space-y-1.5 pl-5 marker:text-[#116644]">
          <li>your order number (you will find it in your confirmation email and under <Link href="/account/orders" className={textLink}>My orders</Link>)</li>
          <li>the email address on your account</li>
          <li>a short description, and a photo if something arrived damaged</li>
        </ul>
        <p>
          Many questions are answered in the <Link href="/help" className={textLink}>help centre</Link>. Never send us your card
          number, PIN, password or one-time codes. We will never ask for them.
        </p>
      </Section>

      <Section id="seller" title="Seller details">
        <SellerDetails />
      </Section>

      <Section id="grievance" title="Grievance officer">
        <p>
          If you have a complaint about an order, a product, our service or the way we handle your personal data, please contact
          our grievance officer.
        </p>
        <GrievanceOfficer />
      </Section>
    </PolicyPage>
  );
}
