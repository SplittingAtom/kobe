/**
 * JSON merge patches (RFC 7386) that replace a value wholesale. A plain merge patch only adds and
 * overwrites keys: a field the current pod template dropped would survive in the Sandbox's stored
 * template. `replacingPatch(current, next)` also nulls every key `next` no longer has, at every
 * object level, so applying it to `current` yields exactly `next`. Arrays and scalars are replaced.
 * (Merge patches cannot express a literal null; pod specs never contain one.)
 */

type Json = unknown;

const isObject = (v: Json): v is Record<string, Json> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function replacingPatch(current: Json, next: Json): Json {
  if (!isObject(next) || !isObject(current)) return next;
  const patch: Record<string, Json> = {};
  for (const key of Object.keys(current)) {
    if (!(key in next)) patch[key] = null;
  }
  for (const [key, value] of Object.entries(next)) {
    patch[key] = replacingPatch(current[key], value);
  }
  return patch;
}
