export interface PasswordContext {
  email?: string;
  firstName?: string;
  lastName?: string;
}

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;

/** NIST-style policy: length over composition rules; reject the obviously guessable. Breach check is separate. */
export function passwordViolations(
  password: string,
  ctx: PasswordContext = {},
): string[] {
  const out: string[] = [];
  if (password.length < PASSWORD_MIN)
    out.push(`must be at least ${PASSWORD_MIN} characters`);
  if (password.length > PASSWORD_MAX)
    out.push(`must be at most ${PASSWORD_MAX} characters`);
  if (new Set(password).size < 5) out.push('is too repetitive');
  const lower = password.toLowerCase();
  // Check every word of the address's local part (jane.smith.1979 -> jane, smith), not just the whole of it.
  const localWords = (
    ctx.email
      ?.split('@')[0]
      ?.toLowerCase()
      .split(/[^a-z0-9]+/) ?? []
  ).filter((w) => w.length >= 4 && !/^\d+$/.test(w));
  if (localWords.some((w) => lower.includes(w)))
    out.push('must not contain your email name');
  for (const name of [ctx.firstName, ctx.lastName]) {
    if (name && name.length >= 4 && lower.includes(name.toLowerCase()))
      out.push('must not contain your name');
  }
  if (
    /^(?:password|qwerty|123456|letmein|welcome|iloveyou|admin)/i.test(password)
  )
    out.push('is a commonly used password');
  return [...new Set(out)];
}
