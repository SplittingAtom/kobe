// Kubernetes quantity arithmetic for the skill-eval quota (KOBE-325): exact, in milli-units, for
// the forms `config.ts` accepts (an optional decimal and one suffix of m, k, M, G, T, Ki, Mi, Gi,
// Ti). Results are written as a plain integer, or in `m` when they have a fraction.

const FACTORS: Readonly<Record<string, bigint>> = {
  "": 1000n,
  m: 1n,
  k: 1000n * 1000n,
  M: 1000n * 1000n ** 2n,
  G: 1000n * 1000n ** 3n,
  T: 1000n * 1000n ** 4n,
  Ki: 1000n * 1024n,
  Mi: 1000n * 1024n ** 2n,
  Gi: 1000n * 1024n ** 3n,
  Ti: 1000n * 1024n ** 4n,
};

const PATTERN = /^(\d+)(?:\.(\d+))?(m|k|M|G|T|Ki|Mi|Gi|Ti)?$/;

/** A quantity in milli-units (rounded up: a quota never ends up smaller than asked). */
export function toMilli(q: string): bigint {
  const m = PATTERN.exec(q);
  if (!m?.[1]) throw new Error(`not a quantity: ${q}`);
  const factor = FACTORS[m[3] ?? ""] ?? 1000n;
  const frac = m[2] ?? "";
  const scale = 10n ** BigInt(frac.length);
  const whole = BigInt(m[1]) * scale + (frac ? BigInt(frac) : 0n);
  const num = whole * factor;
  return (num + scale - 1n) / scale;
}

export function fromMilli(v: bigint): string {
  return v % 1000n === 0n ? String(v / 1000n) : `${v}m`;
}

export const addQuantities = (a: string, b: string): string => fromMilli(toMilli(a) + toMilli(b));
export const scaleQuantity = (q: string, n: number): string => fromMilli(toMilli(q) * BigInt(n));
