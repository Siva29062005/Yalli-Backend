import { canonicalFor } from '@/lib/site';
import type { Metadata } from 'next';
import Link from 'next/link';
import { complaintEmail } from '@/lib/business';
import { SellerDetails } from '@/components/BusinessInfo';
import { List, POLICY_UPDATED, PolicyPage, Section, textLink, type PolicySection } from '@/components/PolicyPage';

export const metadata: Metadata = {
  ...canonicalFor('/privacy'),
  title: 'Privacy policy | Yalli',
  description: 'What personal data Yalli collects, why, who sees it, how long we keep it and how you can control it.',
};

const sections: PolicySection[] = [
  { id: 'who', title: 'Who we are' },
  { id: 'collect', title: 'What we collect and why' },
  { id: 'payments', title: 'Payments' },
  { id: 'share', title: 'Who we share it with' },
  { id: 'storage', title: 'Cookies and browser storage' },
  { id: 'keep', title: 'How long we keep it' },
  { id: 'rights', title: 'Your choices and rights' },
  { id: 'security', title: 'How we protect it' },
  { id: 'children', title: 'Children' },
  { id: 'changes', title: 'Changes and contact' },
];

export default function PrivacyPage() {
  const contact = complaintEmail();
  return (
    <PolicyPage
      title="Privacy policy"
      intro="We collect only what we need to run your account and deliver your orders. This page explains what that is, in plain words."
      updated={POLICY_UPDATED}
      sections={sections}
    >
      <Section id="who" title="Who we are">
        <p>
          This store is run by the seller below. In this policy, “we” means that seller, and we decide why and how your personal
          data is used.
        </p>
        <SellerDetails />
      </Section>

      <Section id="collect" title="What we collect and why">
        <List>
          <li>
            <strong>Account:</strong> your name, email address, optionally your phone number, and your password (we keep only a
            one-way scrambled form of it, never the password itself). If you turn on two-step verification we keep the secret
            for your authenticator app in encrypted form. <em>Why:</em> to create and protect your account.
          </li>
          <li>
            <strong>Orders:</strong> the items you buy, amounts, delivery address and phone number, order status, tracking
            details and your tax invoice. <em>Why:</em> to take payment, deliver, give support, handle returns and refunds, and
            meet tax and accounting rules.
          </li>
          <li>
            <strong>Your lists:</strong> your cart, wishlist and saved addresses. <em>Why:</em> so they are there when you come
            back.
          </li>
          <li>
            <strong>Reviews:</strong> the rating and text you write. Only customers who received a product can review it. Reviews
            are checked before they appear, and the public sees only your first name and the initial of your surname.
          </li>
          <li>
            <strong>Security records:</strong> when and from where you sign in (IP address, browser and device description), failed
            sign-in attempts and important account changes such as a password change. <em>Why:</em> to keep your account safe
            and to alert you to a sign-in from a new device.
          </li>
          <li>
            <strong>Your consent choices:</strong> that you accepted this policy and our terms when you registered, and whether
            you want offers by email. <em>Why:</em> to show what you agreed to and honour it.
          </li>
          <li>
            <strong>Messages we send you:</strong> account emails (verification, password reset, new-device and security
            alerts), order emails (confirmation, shipped, delivered, cancelled, refund and return updates) and one-time codes by
            SMS if you verify a phone number. If you opt in, offers and new-arrival emails.
          </li>
        </List>
        <p>
          We use your data to provide the store you asked for, to meet our legal duties, to prevent fraud and abuse, and, only
          if you say yes, to send offers. We do not sell your personal data and we do not use it for advertising by third
          parties.
        </p>
      </Section>

      <Section id="payments" title="Payments">
        <p>
          You pay on Razorpay’s secure payment window. Your card, UPI and bank details go to Razorpay and your bank,{' '}
          <strong>never to our servers</strong>. We receive only the result of the payment and keep a reference to it, the
          amount, the status and the payment method type (for example UPI or card), so we can confirm your order and refund it if
          needed.
        </p>
      </Section>

      <Section id="share" title="Who we share it with">
        <p>We share personal data only with the services that help us run the store, and only what each one needs:</p>
        <List>
          <li><strong>Razorpay</strong> to take payments and send refunds.</li>
          <li>
            <strong>Couriers</strong> receive your name, delivery address and phone number so they can deliver your parcel.
          </li>
          <li>
            <strong>Email and SMS providers</strong> (Amazon SES for email, MSG91 for SMS) deliver the messages described above.
          </li>
          <li>
            <strong>Hosting and infrastructure</strong> providers store our systems and data in secure data centres (Amazon Web
            Services).
          </li>
          <li>
            <strong>Safety services:</strong> when switched on, a bot check (Cloudflare Turnstile) on sign-up and sign-in, and a
            check of whether a password has appeared in known data breaches (Have I Been Pwned). That check sends only a short
            fingerprint of the password, never the password.
          </li>
          <li>
            <strong>Authorities</strong> when the law requires it, for example tax authorities or a court order.
          </li>
        </List>
      </Section>

      <Section id="storage" title="Cookies and browser storage">
        <p>
          We do not use advertising or analytics trackers. We store only what the store needs to work in your browser:
        </p>
        <List>
          <li>A secure, HttpOnly sign-in cookie that keeps you signed in. You cannot read it from the page, and it is needed for sign-in.</li>
          <li>
            A sign-in safety token in your browser’s storage (this tab only, or this browser if you choose “remember me”).
          </li>
          <li>A random cart token that keeps a guest cart, and your list of products to compare.</li>
          <li>A short error note if a payment fails, so we can show it on the next page.</li>
        </List>
        <p>
          Two things load from other companies when you use the store: the Inter and Poppins fonts from Google Fonts, which means
          Google can see your IP address, and Razorpay’s payment window on the checkout page, which is Razorpay’s own service.
        </p>
      </Section>

      <Section id="keep" title="How long we keep it">
        <List>
          <li>Account and profile data is kept while your account is open.</li>
          <li>
            When you delete your account we remove or anonymise your personal data: your name and email are replaced, and your
            phone number, saved addresses, cart, wishlist, reviews and two-step verification are deleted, and your sign-ins end.
          </li>
          <li>
            We keep what the law requires us to keep: order and invoice records for the period tax and accounting law
            requires, plus the security log and the record of your consents.
          </li>
          <li>You can turn off offer emails whenever you like, and we stop at once.</li>
        </List>
      </Section>

      <Section id="rights" title="Your choices and rights">
        <p>
          India’s Digital Personal Data Protection Act, 2023 gives you rights over your data. Some parts of that law start on
          later dates, but we follow these practices already.
        </p>
        <List>
          <li>
            <strong>See and correct.</strong> Your name, phone number and saved addresses can be changed in{' '}
            <Link href="/account/profile" className={textLink}>My profile</Link> and{' '}
            <Link href="/account/addresses" className={textLink}>Addresses</Link>. You can download a copy of what we hold in{' '}
            <Link href="/account/data" className={textLink}>Your data</Link>.
          </li>
          <li>
            <strong>Offers by email.</strong> Switch them on or off any time in{' '}
            <Link href="/account/profile" className={textLink}>My profile</Link>.
          </li>
          <li>
            <strong>Delete your account.</strong> Do it yourself in <Link href="/account/data" className={textLink}>Your data</Link>{' '}
            (you confirm with your password, and your authenticator code if two-step verification is on), or ask us using the
            contact details below.
          </li>
          <li>
            <strong>Sign-ins.</strong> You can see and end your signed-in devices under{' '}
            <Link href="/account/sessions" className={textLink}>Active sessions</Link>.
          </li>
          <li>
            <strong>Complain.</strong> Tell our grievance officer first (see below). If you are still not satisfied, you may
            approach the Data Protection Board of India.
          </li>
        </List>
      </Section>

      <Section id="security" title="How we protect it">
        <List>
          <li>Passwords are stored in scrambled form, and two-step verification secrets are encrypted.</li>
          <li>
            You can turn on two-step verification for your account. It is required for our staff before they can open any admin
            page.
          </li>
          <li>Repeated wrong passwords lock sign-in for a while, and you are emailed about sign-ins from new devices.</li>
          <li>Access to customer data inside the company is limited by role, and important actions are logged.</li>
        </List>
        <p>
          No system is perfectly safe. If a breach affects your data we will tell you and the authorities as the law requires.
        </p>
      </Section>

      <Section id="children" title="Children">
        <p>
          Our store is for adults. We do not knowingly collect personal data from anyone under 18. If you are under 18, please
          ask a parent or guardian to place orders for you. If you think a child has given us data, tell us and we will delete it.
        </p>
      </Section>

      <Section id="changes" title="Changes and contact">
        <p>
          If we change how we use personal data we will update this page and its date, and tell you by email if the change is
          important. For privacy questions or requests{contact ? <>, write to <a className={textLink} href={`mailto:${contact}`}>{contact}</a></> : <>, use the details on our <Link href="/contact" className={textLink}>contact page</Link></>}
          . See our <Link href="/contact#grievance" className={textLink}>grievance officer</Link> details to make a complaint.
        </p>
      </Section>
    </PolicyPage>
  );
}
