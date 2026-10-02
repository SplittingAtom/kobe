/** Test helper: the value, or a thrown error naming what was missing (no `!` assertions). */
export function must<T>(value: T | undefined | null, what = "value"): T {
  if (value === undefined || value === null) throw new Error(`expected ${what}`);
  return value;
}
