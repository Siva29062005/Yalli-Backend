/**
 * Seller and contact details shown on the policy and contact pages. They come from NEXT_PUBLIC_BUSINESS_* variables at
 * build time (see .env.example): nothing here is invented, and a missing value is simply left out of the page.
 * `process.env.NEXT_PUBLIC_*` must be written out in full so Next can inline each one.
 */
const clean = (value: string | undefined): string | undefined => {
  const text = value?.trim();
  return text ? text : undefined;
};

export const BUSINESS = {
  tradeName: clean(process.env.NEXT_PUBLIC_BUSINESS_TRADE_NAME) ?? 'Yalli',
  legalName: clean(process.env.NEXT_PUBLIC_BUSINESS_LEGAL_NAME),
  registeredAddress: clean(process.env.NEXT_PUBLIC_BUSINESS_ADDRESS),
  gstin: clean(process.env.NEXT_PUBLIC_BUSINESS_GSTIN),
  sellerState: clean(process.env.NEXT_PUBLIC_BUSINESS_SELLER_STATE) ?? 'Tamil Nadu',
  websiteUrl: clean(process.env.NEXT_PUBLIC_BUSINESS_WEBSITE_URL),
  supportEmail: clean(process.env.NEXT_PUBLIC_BUSINESS_SUPPORT_EMAIL),
  supportPhone: clean(process.env.NEXT_PUBLIC_BUSINESS_SUPPORT_PHONE),
  supportHours: clean(process.env.NEXT_PUBLIC_BUSINESS_SUPPORT_HOURS),
  grievanceOfficerName: clean(process.env.NEXT_PUBLIC_BUSINESS_GRIEVANCE_OFFICER_NAME),
  grievanceOfficerDesignation: clean(process.env.NEXT_PUBLIC_BUSINESS_GRIEVANCE_OFFICER_DESIGNATION),
  grievanceOfficerEmail: clean(process.env.NEXT_PUBLIC_BUSINESS_GRIEVANCE_OFFICER_EMAIL),
  grievanceOfficerPhone: clean(process.env.NEXT_PUBLIC_BUSINESS_GRIEVANCE_OFFICER_PHONE),
} as const;

/** Name to print as the seller: the registered legal name when configured, otherwise the trading name. */
export const sellerName = (): string => BUSINESS.legalName ?? BUSINESS.tradeName;

/** Where customers can write about a complaint or a privacy request (grievance officer first, then general support). */
export const complaintEmail = (): string | undefined => BUSINESS.grievanceOfficerEmail ?? BUSINESS.supportEmail;

/** Reminders for the store owner are shown while developing only, never to customers. */
export const SHOW_OWNER_NOTES = process.env.NODE_ENV !== 'production';
