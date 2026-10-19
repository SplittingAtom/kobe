/**
 * Complexity caps on a tool's `inputSchema` at pin time (KOBE-436 review HIGH-1). App calls
 * validate arguments against the pinned schema in a worker with a deadline; these caps keep any
 * single schema small enough that validation is cheap when it is not malicious, and refuse the
 * obviously abusive ones before anyone approves them. Regular expressions are not judged here
 * (a safe-regex check refuses common, harmless patterns such as `^([a-z]+-)*[a-z]+$`); the
 * worker's deadline bounds them instead.
 */
export const SCHEMA_LIMITS = {
  /** JSON nodes (objects, arrays and scalars) in the schema. */
  nodes: 5_000,
  /** Nesting depth. */
  depth: 32,
  /** `pattern` / `patternProperties` keys in the schema. */
  patterns: 100,
  /** Length of one regular expression. */
  patternLength: 1_024,
  /** `$ref` / `$dynamicRef` uses. */
  refs: 200,
} as const;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function schemaWithinLimits(schema: unknown): boolean {
  let nodes = 0;
  let patterns = 0;
  let refs = 0;
  const walk = (value: unknown, depth: number): boolean => {
    nodes += 1;
    if (nodes > SCHEMA_LIMITS.nodes || depth > SCHEMA_LIMITS.depth) return false;
    if (Array.isArray(value)) return value.every((v) => walk(v, depth + 1));
    if (!isObject(value)) return true;
    for (const [key, v] of Object.entries(value)) {
      if (key === "pattern" && typeof v === "string") {
        patterns += 1;
        if (v.length > SCHEMA_LIMITS.patternLength) return false;
      }
      if (key === "patternProperties" && isObject(v)) {
        for (const p of Object.keys(v)) {
          patterns += 1;
          if (p.length > SCHEMA_LIMITS.patternLength) return false;
        }
      }
      if (key === "$ref" || key === "$dynamicRef") refs += 1;
      if (patterns > SCHEMA_LIMITS.patterns || refs > SCHEMA_LIMITS.refs) return false;
      if (!walk(v, depth + 1)) return false;
    }
    return true;
  };
  return walk(schema, 0);
}
