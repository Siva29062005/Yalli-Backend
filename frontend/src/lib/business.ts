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

/**
 * The home page banner, supplied by the owner: an image in `public/` (e.g. `/banners/home-hero.webp`) and its alt text.
 * Only a local path is used (no third-party image host). Without it the hero shows a real product photo, or none.
 */
const heroImage = clean(process.env.NEXT_PUBLIC_HOME_HERO_IMAGE);
export const HOME_HERO = {
  // a file in public/ only: not protocol-relative ("//host"), not Next's or the API's paths, no ".."
  image:
    heroImage && /^\/(?!\/)(?!_next\/|api\/)[A-Za-z0-9/_.-]+\.(webp|jpe?g|png|avif)$/i.test(heroImage) && !heroImage.includes('..')
      ? heroImage
      : undefined,
  alt: clean(process.env.NEXT_PUBLIC_HOME_HERO_ALT) ?? '',
} as const;

/** Name to print as the seller: the registered legal name when configured, otherwise the trading name. */
export const sellerName = (): string => BUSINESS.legalName ?? BUSINESS.tradeName;

/** Where customers can write about a complaint or a privacy request (grievance officer first, then general support). */
export const complaintEmail = (): string | undefined => BUSINESS.grievanceOfficerEmail ?? BUSINESS.supportEmail;

/** Reminders for the store owner are shown while developing only, never to customers. */
export const SHOW_OWNER_NOTES = process.env.NODE_ENV !== 'production';
