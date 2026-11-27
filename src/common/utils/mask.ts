/**
 * Contact details shown to support staff (pure, unit-tested): enough to confirm "is this you?" with a caller, not enough
 * to copy someone's address book. Staff search with the FULL email/phone the customer gives them, so nothing is lost.
 */

/** "priya.r@example.com" -> "pr•••@example.com"; a 1-2 character local part keeps only its first character. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 1) return '•••';
  const local = email.slice(0, at);
  const keep = local.length > 2 ? 2 : 1;
  return `${local.slice(0, keep)}•••${email.slice(at)}`;
}

/** "+919876543210" -> "+91 ••••• •3210" (last four digits only). */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 4) return '•••';
  const country = phone.startsWith('+91')
    ? '+91 '
    : phone.startsWith('+')
      ? '+'
      : '';
  return `${country}••••• •${digits.slice(-4)}`;
}
