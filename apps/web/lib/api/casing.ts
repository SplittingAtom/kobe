/**
 * Key casing at the API boundary. The server mixes camelCase (KOBE-13/14/45 routes) and snake_case
 * (spec §6.1 bodies, KOBE-34+). The web client sees camelCase only: every JSON response passes
 * through `camelizeKeys`, so a route switching casing later doesn't break a page. Request bodies
 * are written in each route's own wire casing by the resource modules (`lib/admin/api/*`).
 */

/** Values under these keys are documents, not API fields (agent frontmatter; policy arg patterns keyed by JSON pointers): their keys stay as sent. */
const OPAQUE_KEYS: ReadonlySet<string> = new Set(["frontmatter", "argPattern"]);

/** `owner_user_id` → `ownerUserId`; camelCase and leading/double underscores are left alone. */
export function toCamel(key: string): string {
  return key.replace(/([a-z0-9])_([a-z0-9])/g, (_, a: string, b: string) => a + b.toUpperCase());
}

export function camelizeKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(camelizeKeys);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    // A JSON `__proto__` key would replace the copy's prototype on assignment: drop it.
    if (key === "__proto__") continue;
    const name = toCamel(key);
    out[name] = OPAQUE_KEYS.has(name) ? inner : camelizeKeys(inner);
  }
  return out;
}
