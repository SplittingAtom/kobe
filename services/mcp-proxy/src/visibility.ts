/**
 * MCP Apps visibility as the upstream declares it (KOBE-435 review M3), for the proxy's own check
 * when an older server (mid-rollout or after a rollback) allowed a call without checking it. The
 * same rules as the server's pin: absent → the model and apps; not an array (malformed) → the
 * model only; an array → visible to the model only if it lists `"model"`.
 */
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function upstreamModelVisible(tool: unknown): boolean {
  const meta = isObject(tool) ? tool._meta : undefined;
  const ui = isObject(meta) ? meta.ui : undefined;
  const visibility = isObject(ui) ? ui.visibility : undefined;
  if (visibility === undefined || !Array.isArray(visibility)) return true;
  return visibility.includes("model");
}
