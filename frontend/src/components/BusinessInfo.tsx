import { BUSINESS, SHOW_OWNER_NOTES, complaintEmail, sellerName } from '@/lib/business';
import { Callout, textLink } from '@/components/PolicyPage';

const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="grid gap-0.5 sm:grid-cols-[11rem_1fr] sm:gap-3">
    <dt className="text-[13px] font-semibold uppercase tracking-wide text-[#4A5550]">{label}</dt>
    <dd className="break-words">{children}</dd>
  </div>
);

const mail = (address: string) => (
  <a className={textLink} href={`mailto:${address}`}>
    {address}
  </a>
);
const tel = (number: string) => (
  <a className={textLink} href={`tel:${number.replace(/[^\d+]/g, '')}`}>
    {number}
  </a>
);

/** Reminder for the store owner, visible only while developing. */
function OwnerNote({ children }: { children: React.ReactNode }) {
  return SHOW_OWNER_NOTES ? <Callout tone="owner">To be added by the store owner: {children}</Callout> : null;
}

/** Who sells: required on an Indian e-commerce site. Only configured values are printed. */
export function SellerDetails() {
  const any = BUSINESS.legalName || BUSINESS.registeredAddress || BUSINESS.gstin;
  return (
    <div className="space-y-3">
      <dl className="space-y-2">
        <Row label="Sold by">{sellerName()}</Row>
        {BUSINESS.registeredAddress && <Row label="Registered address">{BUSINESS.registeredAddress}</Row>}
        {BUSINESS.gstin && <Row label="GSTIN">{BUSINESS.gstin}</Row>}
        <Row label="State of supply">{BUSINESS.sellerState}</Row>
      </dl>
      {!any && <OwnerNote>legal name, registered address and GSTIN (NEXT_PUBLIC_BUSINESS_LEGAL_NAME, _ADDRESS, _GSTIN).</OwnerNote>}
    </div>
  );
}

export function SupportDetails() {
  const any = BUSINESS.supportEmail || BUSINESS.supportPhone;
  return (
    <div className="space-y-3">
      {any && (
        <dl className="space-y-2">
          {BUSINESS.supportEmail && <Row label="Email">{mail(BUSINESS.supportEmail)}</Row>}
          {BUSINESS.supportPhone && <Row label="Phone">{tel(BUSINESS.supportPhone)}</Row>}
          {BUSINESS.supportHours && <Row label="Hours">{BUSINESS.supportHours}</Row>}
        </dl>
      )}
      {!any && <OwnerNote>support email and phone (NEXT_PUBLIC_BUSINESS_SUPPORT_EMAIL, _PHONE, _HOURS).</OwnerNote>}
    </div>
  );
}

/**
 * Consumer Protection (E-Commerce) Rules, 2020: the grievance officer's name, designation and contact are shown, with the
 * time limits. The promise is printed only when there is a way to reach someone, so an empty contact block never makes a promise.
 */
export function GrievanceOfficer() {
  const reachable = Boolean(complaintEmail() ?? BUSINESS.grievanceOfficerPhone ?? BUSINESS.supportPhone);
  const named = BUSINESS.grievanceOfficerName || BUSINESS.grievanceOfficerDesignation;
  return (
    <div className="space-y-3">
      {(named || BUSINESS.grievanceOfficerEmail || BUSINESS.grievanceOfficerPhone) && (
        <dl className="space-y-2">
          {BUSINESS.grievanceOfficerName && <Row label="Name">{BUSINESS.grievanceOfficerName}</Row>}
          {BUSINESS.grievanceOfficerDesignation && <Row label="Designation">{BUSINESS.grievanceOfficerDesignation}</Row>}
          {BUSINESS.grievanceOfficerEmail && <Row label="Email">{mail(BUSINESS.grievanceOfficerEmail)}</Row>}
          {BUSINESS.grievanceOfficerPhone && <Row label="Phone">{tel(BUSINESS.grievanceOfficerPhone)}</Row>}
        </dl>
      )}
      {!named && !BUSINESS.grievanceOfficerEmail && !BUSINESS.grievanceOfficerPhone && complaintEmail() && (
        <p>
          Write to {mail(complaintEmail()!)} and mark your message “Complaint”. It reaches the person who handles grievances.
        </p>
      )}
      {reachable && (
        <p>
          We acknowledge every complaint within <strong>48 hours</strong> and aim to resolve it within <strong>one month</strong> of
          receiving it. Please include your order number so we can find your order quickly.
        </p>
      )}
      <OwnerNote>
        the grievance officer’s name, designation, email and phone (NEXT_PUBLIC_BUSINESS_GRIEVANCE_OFFICER_NAME, _DESIGNATION,
        _EMAIL, _PHONE). The e-commerce rules require these to be shown.
      </OwnerNote>
    </div>
  );
}
