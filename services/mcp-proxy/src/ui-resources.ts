/**
 * The pin probe's MCP Apps templates (KOBE-433, spec mcp-apps-host §5, MA1). After `tools/list`,
 * the server's probe may ask for the `ui://` templates the live tools name in
 * `_meta.ui.resourceUri`: the proxy runs `resources/list` and reads each named URI that is listed,
 * and nothing else (no other scheme, no unlisted or unnamed resource). This runs only for the
 * server's internal probe; Pi's `/v1/mcp` keeps answering `resources/*` with "method not found".
 *
 * A template that is too large, not text or not UTF-8, or whose read the server refuses, comes
 * back as a per-template `error` so the server can refuse to pin it with a clear code. The server
 * validates and hashes everything itself.
 */

/** Most templates one probe reads. */
export const MAX_UI_RESOURCES = 16;
/** Largest template the proxy passes on (MA9: 512 KiB of UTF-8). */
export const UI_RESOURCE_MAX_BYTES = 512 * 1024;
/** Most `resources/list` pages a probe follows. */
export const MAX_RESOURCE_PAGES = 20;
const URI_MAX = 2048;
const UI_URI = /^ui:\/\/\S+$/;
const METHOD_NOT_FOUND = -32601;

export type UiResource =
  | {
      readonly uri: string;
      readonly mimeType?: string;
      readonly text: string;
      /** `_meta` of the list entry, the read result and the content item (in that order, merged). */
      readonly meta: Record<string, unknown>;
    }
  | { readonly uri: string; readonly error: "too_large" | "invalid" };

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
  | { readonly ok: false; readonly failure: "too_large" | "protocol_error" };

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

type Listed = Map<string, Record<string, unknown>>;

/** `resources/list` (all pages): each listed URI with its entry's `_meta`. */
async function listResources(
  request: SessionRequest,
): Promise<{ ok: true; listed: Listed } | Extract<UiResourcesOutcome, { ok: false }>> {
  const listed: Listed = new Map();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_RESOURCE_PAGES; page += 1) {
    const answer = await request("resources/list", cursor === undefined ? {} : { cursor });
    if (!answer.ok) {
      // A server without resources has no templates; anything else is a failed probe.
      if (answer.code === METHOD_NOT_FOUND) return { ok: true, listed };
      return { ok: false, failure: "protocol_error" };
    }
    const entries = answer.result.resources;
    if (!Array.isArray(entries)) return { ok: false, failure: "protocol_error" };
    for (const entry of entries) {
      if (isObject(entry) && typeof entry.uri === "string") {
        listed.set(entry.uri, isObject(entry._meta) ? entry._meta : {});
      }
    }
    const next = answer.result.nextCursor;
    if (typeof next !== "string" || next === "") return { ok: true, listed };
    cursor = next;
  }
  return { ok: false, failure: "too_large" };
}

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });
/** With the `u` flag a surrogate matches only when it is unpaired (not valid UTF-8). */
const LONE_SURROGATE = /[\uD800-\uDFFF]/u;

/** The content's text: `text`, or a base64 `blob` that is valid UTF-8. */
function textOf(content: Record<string, unknown>): string | "too_large" | undefined {
  if (typeof content.text === "string") {
    if (LONE_SURROGATE.test(content.text)) return undefined;
    return Buffer.byteLength(content.text, "utf8") > UI_RESOURCE_MAX_BYTES
      ? "too_large"
      : content.text;
  }
  if (typeof content.blob !== "string") return undefined;
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
  if (!answer.ok) return { uri, error: "invalid" };
  const contents = answer.result.contents;
  const content = Array.isArray(contents)
    ? contents.find((c): c is Record<string, unknown> => isObject(c) && c.uri === uri)
    : undefined;
  if (!content) return { uri, error: "invalid" };
  const text = textOf(content);
  if (text === undefined) return { uri, error: "invalid" };
  if (text === "too_large") return { uri, error: "too_large" };
  const resultMeta = isObject(answer.result._meta) ? answer.result._meta : {};
  const contentMeta = isObject(content._meta) ? content._meta : {};
  return {
    uri,
    ...(typeof content.mimeType === "string" ? { mimeType: content.mimeType } : {}),
    text,
    meta: { ...listMeta, ...resultMeta, ...contentMeta },
  };
}

/** The templates the tools name that the server lists, read one at a time. */
export async function readUiResources(
  tools: readonly unknown[],
  request: SessionRequest,
): Promise<UiResourcesOutcome> {
  const wanted = referencedUiUris(tools);
  if (wanted.length === 0) return { ok: true, resources: [] };
  if (wanted.length > MAX_UI_RESOURCES) return { ok: false, failure: "too_large" };
  const list = await listResources(request);
  if (!list.ok) return list;
  const resources: UiResource[] = [];
  for (const uri of wanted) {
    const listMeta = list.listed.get(uri);
    if (listMeta !== undefined) resources.push(await readOne(request, uri, listMeta));
  }
  return { ok: true, resources };
}
