/** Splits GST (already INCLUDED in the price) into the components shown on an Indian tax invoice. */
export function splitGst(
  gstMinor: number,
  sameState: boolean,
): { cgstMinor: number; sgstMinor: number; igstMinor: number } {
  if (!Number.isSafeInteger(gstMinor) || gstMinor < 0)
    throw new RangeError('gst must be a non-negative integer (paise)');
  if (!sameState) return { cgstMinor: 0, sgstMinor: 0, igstMinor: gstMinor };
  const cgstMinor = Math.floor(gstMinor / 2);
  return { cgstMinor, sgstMinor: gstMinor - cgstMinor, igstMinor: 0 }; // CGST + SGST always equals the whole GST
}

export const sameStateSupply = (
  shipState: string,
  sellerState: string,
): boolean =>
  shipState.trim().toLowerCase() === sellerState.trim().toLowerCase();
