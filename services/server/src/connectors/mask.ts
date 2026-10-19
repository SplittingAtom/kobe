/** Last four characters of a long key; nothing of a short one (KOBE-108, KOBE-303). */
export function maskHint(apiKey: string): string {
  return apiKey.length >= 16 ? `••••${apiKey.slice(-4)}` : "••••";
}
