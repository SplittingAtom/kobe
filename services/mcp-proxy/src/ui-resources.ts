/**
 * The pin probe's MCP Apps templates (KOBE-433, spec mcp-apps-host §5, MA1). After `tools/list`,
 * the server's probe may ask for the `ui://` templates the live tools name in
 * `_meta.ui.resourceUri`: the proxy runs `resources/list` and reads each named URI that is listed,
 * and nothing else (no other scheme, no unlisted or unnamed resource). This runs only for the
 * server's internal probe; Pi's `/v1/mcp` keeps answering `resources/*` with "method not found".
 *
 * Template problems never fail the tool probe (review MEDIUM-3):
 * - per template, `{uri, error}`: too large, not text or not UTF-8, oversized `_meta`, a refused
 *   or mismatched read, or beyond the {@link MAX_UI_RESOURCES} the probe reads;
 * - for the whole template part, `skipped` with a reason: `resources/list` failed (other than
 *   "method not found", which means no templates) or a transport failure while reading. The
 *   server then leaves the stored templates as they are.
 * The server validates and hashes everything itself.
 */

/** Most templates one probe reads; the rest come back as `invalid`. */
export const MAX_UI_RESOURCES = 16;
/** Largest template the proxy passes on (MA9: 512 KiB of UTF-8). */
export const UI_RESOURCE_MAX_BYTES = 512 * 1024;
/** Largest `_meta` (the kept keys, serialized) the proxy passes on per template. */
export const UI_RESOURCE_META_MAX_BYTES = 16 * 1024;
/** Most `resources/list` pages a probe follows; beyond it the template part is skipped. */
export const MAX_RESOURCE_PAGES = 20;
/** The `_meta` keys the server uses; everything else is dropped before it is passed on. */
const KEPT_META_KEYS = ["ui", "io.splittingatom/contentHash"] as const;
const URI_MAX = 2048;
/** Printable ASCII only: no space, control character or NUL (Postgres refuses NUL). */
const UI_URI = /^ui:\/\/[\x21-\x7e]+$/;
const METHOD_NOT_FOUND = -32601;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

export type UiResourceError = "too_large" | "invalid";

export type UiResource =
  | {
      readonly uri: string;
      readonly mimeType?: string;
      readonly text: string;
      /** `ui` and the contentHash from the list entry, read result and content item (merged). */
      readonly meta: Record<string, unknown>;
    }
  | { readonly uri: string; readonly error: UiResourceError };

/** One JSON-RPC request in the probe's session: its `result`, or why it failed. */
export type SessionRequest = (
  method: string,
  params: Record<string, unknown>,
) => Promise<
  | { readonly ok: true; readonly result: Record<string, unknown> }
  | { readonly ok: false; readonly failure: string; readonly code?: number }
>;

export type UiResourcesOutcome =
  | { readonly ok: true; readonly resources: UiResource[] }
  | { readonly ok: false; readonly skipped: string };

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The distinct `ui://` URIs the tools name, in first-seen order. */
export function referencedUiUris(tools: readonly unknown[]): string[] {
  const uris = new Set<string>();
  for (const tool of tools) {
    const meta = isObject(tool) ? tool._meta : undefined;
    const ui = isObject(meta) ? meta.ui : undefined;
    const uri = isObject(ui) ? ui.resourceUri : undefined;
    if (typeof uri === "string" && uri.length <= URI_MAX && UI_URI.test(uri)) uris.add(uri);
  }
  return [...uris];
}

/** Only the kept keys of a `_meta` object. */
function keptMeta(value: unknown): Record<string, unknown> {
  if (!isObject(value)) return {};
  const kept: Record<string, unknown> = {};
  for (const key of KEPT_META_KEYS) if (key in value) kept[key] = value[key];
  return kept;
}

type Listed = Map<string, Record<string, unknown>>;

/** `resources/list` (all pages): each wanted URI that is listed, with its entry's kept `_meta`. */
async function listResources(
  request: SessionRequest,
  wanted: ReadonlySet<string>,
): Promise<{ ok: true; listed: Listed } | { ok: false; skipped: string }> {
  const listed: Listed = new Map();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_RESOURCE_PAGES; page += 1) {
    const answer = await request("resources/list", cursor === undefined ? {} : { cursor });
    if (!answer.ok) {
      // A server without resources has no templates; anything else skips the template part.
      if (answer.code === METHOD_NOT_FOUND) return { ok: true, listed };
      return { ok: false, skipped: answer.failure };
    }
    const entries = answer.result.resources;
    if (!Array.isArray(entries)) return { ok: false, skipped: "protocol_error" };
    for (const entry of entries) {
      if (isObject(entry) && typeof entry.uri === "string" && wanted.has(entry.uri)) {
        listed.set(entry.uri, keptMeta(entry._meta));
      }
    }
    const next = answer.result.nextCursor;
    if (typeof next !== "string" || next === "") return { ok: true, listed };
    cursor = next;
  }
  return { ok: false, skipped: "too_large" };
}

// `ignoreBOM`: keep a leading BOM, so Kobe hashes the bytes the upstream hashed (review LOW-2).
const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
/** With the `u` flag a surrogate matches only when it is unpaired (not valid UTF-8). */
const LONE_SURROGATE = /[\uD800-\uDFFF]/u;

/** The content's text: `text`, or a strict-base64 `blob` that is valid UTF-8. */
function textOf(content: Record<string, unknown>): string | "too_large" | undefined {
  if (typeof content.text === "string") {
    if (LONE_SURROGATE.test(content.text)) return undefined;
    return Buffer.byteLength(content.text, "utf8") > UI_RESOURCE_MAX_BYTES
      ? "too_large"
      : content.text;
  }
  if (typeof content.blob !== "string" || !BASE64.test(content.blob)) return undefined;
  if (content.blob.length > Math.ceil(UI_RESOURCE_MAX_BYTES / 3) * 4) return "too_large";
  const bytes = Buffer.from(content.blob, "base64");
  if (bytes.byteLength > UI_RESOURCE_MAX_BYTES) return "too_large";
  try {
    return strictUtf8.decode(bytes);
  } catch {
    return undefined;
  }
}

async function readOne(
  request: SessionRequest,
  uri: string,
  listMeta: Record<string, unknown>,
): Promise<UiResource> {
  const answer = await request("resources/read", { uri });
  if (!answer.ok) return { uri, error: answer.failure === "too_large" ? "too_large" : "invalid" };
  const contents = answer.result.contents;
  const content = Array.isArray(contents)
    ? contents.find((c): c is Record<string, unknown> => isObject(c) && c.uri === uri)
    : undefined;
  if (!content) return { uri, error: "invalid" };
  const text = textOf(content);
  if (text === undefined) return { uri, error: "invalid" };
  if (text === "too_large") return { uri, error: "too_large" };
  const meta = {
    ...listMeta,
    ...keptMeta(answer.result._meta),
    ...keptMeta(content._meta),
  };
  if (Buffer.byteLength(JSON.stringify(meta), "utf8") > UI_RESOURCE_META_MAX_BYTES) {
    return { uri, error: "invalid" };
  }
  return {
    uri,
    ...(typeof content.mimeType === "string" ? { mimeType: content.mimeType } : {}),
    text,
    meta,
  };
}

/**
 * The templates the tools name that the server lists, read one at a time. A request that throws
 * (transport failure) propagates; the caller skips the template part for it.
 */
export async function readUiResources(
  tools: readonly unknown[],
  request: SessionRequest,
): Promise<UiResourcesOutcome> {
  const named = referencedUiUris(tools);
  if (named.length === 0) return { ok: true, resources: [] };
  const wanted = named.slice(0, MAX_UI_RESOURCES);
  const list = await listResources(request, new Set(wanted));
  if (!list.ok) return list;
  const resources: UiResource[] = [];
  for (const uri of wanted) {
    const listMeta = list.listed.get(uri);
    if (listMeta !== undefined) resources.push(await readOne(request, uri, listMeta));
  }
  // Beyond the cap: reported, never read.
  for (const uri of named.slice(MAX_UI_RESOURCES)) resources.push({ uri, error: "invalid" });
  return { ok: true, resources };
}
