/**
 * Format integer paise into INR string: e.g. 49000 -> "₹490.00"
 */
export function formatPaise(paise: number, includeDecimals = true): string {
  const rupees = paise / 100;
  if (!includeDecimals && Number.isInteger(rupees)) {
    return `₹${rupees.toLocaleString("en-IN")}`;
  }
  return `₹${rupees.toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * Calculate discount percentage between MRP and Sale Price
 */
export function calculateDiscountPercent(regularPaise: number, salePaise: number): number {
  if (regularPaise <= 0 || salePaise >= regularPaise) return 0;
  return Math.round(((regularPaise - salePaise) / regularPaise) * 100);
}

/**
 * Format Indian dates: e.g. "18 Nov 2026"
 */
export function formatIndianDate(dateStringOrDate: string | Date): string {
  const date = typeof dateStringOrDate === "string" ? new Date(dateStringOrDate) : dateStringOrDate;
  return date.toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    // Always India time: the server (UTC) and the browser must render the same day (no hydration mismatch), and staff
    // outside India must see the shop's calendar day.
    timeZone: "Asia/Kolkata",
  });
}

/**
 * Mask email or phone for privacy
 */
export function maskContact(val: string): string {
  if (val.includes("@")) {
    const [name, domain] = val.split("@");
    return `${name.slice(0, 2)}***@${domain}`;
  }
  if (val.length >= 10) {
    return `${val.slice(0, 3)}****${val.slice(-3)}`;
  }
  return val;
}

/** Indian date and time in the shop's time zone: e.g. "18 Nov 2026, 3:45 pm" */
export function formatDateTime(dateStringOrDate: string | Date): string {
  const date = typeof dateStringOrDate === "string" ? new Date(dateStringOrDate) : dateStringOrDate;
  return date.toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "Asia/Kolkata",
  });
}
