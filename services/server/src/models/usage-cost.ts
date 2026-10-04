/**
 * Exact dollar arithmetic on the ledger's `numeric(20,10)` cost (KOBE-43): costs travel as numeric
 * text and are added as scaled integers, never as floats, so budgets (KOBE-42) can reuse them.
 * The float `cost_usd` of a report is for display only.
 */
const SCALE = 10;
const UNIT = 10n ** BigInt(SCALE);

/** Numeric text (`"0.0460000000"`, `"12"`) as an integer count of 1e-10 dollars. */
export function costToUnits(text: string): bigint {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text.trim());
  if (!m) throw new Error(`invalid cost: ${text}`);
  const frac = (m[3] ?? "").slice(0, SCALE).padEnd(SCALE, "0");
  const units = BigInt(m[2] ?? "0") * UNIT + BigInt(frac);
  return m[1] ? -units : units;
}

/** Integer 1e-10 dollars back to numeric text with exactly 10 decimals. */
export function unitsToCost(units: bigint): string {
  const neg = units < 0n;
  const abs = neg ? -units : units;
  const frac = (abs % UNIT).toString().padStart(SCALE, "0");
  return `${neg ? "-" : ""}${abs / UNIT}.${frac}`;
}

export const addCosts = (a: string, b: string): string =>
  unitsToCost(costToUnits(a) + costToUnits(b));

/** Display only: the float of an exact cost. */
export const costForDisplay = (text: string): number => Number(text);
