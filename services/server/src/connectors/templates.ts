import { createHash } from "node:crypto";
import {
  UI_RESOURCE_MAX_BYTES,
  UI_RESOURCE_MIME_TYPE,
  UI_RESOURCE_URI_PATTERN,
  uiResourceMetaSchema,
  type ProposedUiResource,
  type UiResourceFailure,
  type UiResourceMeta,
} from "@kobe/db";
import { canonicalJson } from "@kobe/protocol";
import { z } from "zod";

/**
 * MCP Apps templates (KOBE-433, spec mcp-apps-host §5, MA9). Pure; nothing here touches the
 * database. The proxy's probe returns the `ui://` templates the live tools name; Kobe validates
 * them, hashes the bytes itself (a server's `contentHash` is only cross-checked) and pins them
 * like tools: a changed template is `drifted` (approved bytes kept, live ones proposed), a new one
 * is `drifted` until approved, and one the server no longer lists is removed. Only `pinned`
 * templates are ever served.
 */

/** The `_meta` key Catalyst (M6) uses for the template's SHA-256. */
export const CONTENT_HASH_KEY = "io.splittingatom/contentHash";

/** A valid live template: Kobe's own hashes over exactly what it would store. */
export interface LiveTemplate {
  readonly uri: string;
  readonly mimeType: string;
  readonly html: string;
  readonly sha256: string;
  readonly meta: UiResourceMeta;
  /** SHA-256 of the canonical `{uri, mimeType, sha256, ui}`: what drift compares. */
  readonly pinnedHash: string;
}

/** A live template that cannot be pinned, and why. */
export interface InvalidTemplate {
  readonly uri: string;
  readonly invalid: UiResourceFailure;
}

export type LiveEntry = LiveTemplate | InvalidTemplate;

/** A row of `connector_ui_resources` as drift sees it. */
export interface StoredTemplate extends LiveTemplate {
  readonly status: "pinned" | "drifted";
  readonly proposed?: ProposedUiResource | undefined;
}

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

const proxyEntrySchema = z.union([
  z.object({
    uri: z.string(),
    mimeType: z.string().optional(),
    text: z.string(),
    meta: z.record(z.string(), z.unknown()).default({}),
  }),
  z.object({ uri: z.string(), error: z.string() }),
]);

const invalid = (uri: string, reason: UiResourceFailure): InvalidTemplate => ({
  uri,
  invalid: reason,
});

/** A server's contentHash, normalized (hex, lower case, optional `sha256:` prefix). */
function declaredHash(meta: Record<string, unknown>): string | undefined {
  const value = meta[CONTENT_HASH_KEY];
  if (typeof value !== "string") return undefined;
  return value.toLowerCase().replace(/^sha256:/, "");
}

export function templatePinnedHash(
  t: Pick<LiveTemplate, "uri" | "mimeType" | "sha256" | "meta">,
): string {
  return sha256(canonicalJson({ uri: t.uri, mimeType: t.mimeType, sha256: t.sha256, ui: t.meta }));
}

function validate(entry: z.infer<typeof proxyEntrySchema>): LiveEntry {
  if ("error" in entry) return invalid(entry.uri, "ui_resource_invalid");
  if (entry.mimeType !== UI_RESOURCE_MIME_TYPE) return invalid(entry.uri, "ui_resource_invalid");
  if (/[\uD800-\uDFFF]/u.test(entry.text)) return invalid(entry.uri, "ui_resource_invalid");
  if (Buffer.byteLength(entry.text, "utf8") > UI_RESOURCE_MAX_BYTES) {
    return invalid(entry.uri, "ui_resource_invalid");
  }
  const hash = sha256(entry.text);
  const declared = declaredHash(entry.meta);
  if (declared !== undefined && declared !== hash) {
    return invalid(entry.uri, "ui_resource_hash_mismatch");
  }
  const ui = uiResourceMetaSchema.safeParse(entry.meta.ui ?? {});
  if (!ui.success) return invalid(entry.uri, "ui_resource_invalid");
  const base = { uri: entry.uri, mimeType: entry.mimeType, sha256: hash, meta: ui.data };
  try {
    return { ...base, html: entry.text, pinnedHash: templatePinnedHash(base) };
  } catch {
    // canonicalJson refuses values JSON cannot carry (depth, non-finite numbers, ...).
    return invalid(entry.uri, "ui_resource_invalid");
  }
}

/**
 * The live templates from the probe's `ui_resources`, keeping only those a live tool names (the
 * proxy already reads no others). Entries that do not parse are dropped.
 */
export function liveTemplates(
  tools: readonly { readonly ui?: { readonly resource_uri: string } | undefined }[],
  raw: readonly unknown[],
): LiveEntry[] {
  const named = new Set(tools.flatMap((t) => (t.ui ? [t.ui.resource_uri] : [])));
  const seen = new Set<string>();
  const entries: LiveEntry[] = [];
  for (const item of raw) {
    const parsed = proxyEntrySchema.safeParse(item);
    if (!parsed.success) continue;
    const { uri } = parsed.data;
    if (!named.has(uri) || seen.has(uri) || !UI_RESOURCE_URI_PATTERN.test(uri)) continue;
    seen.add(uri);
    entries.push(validate(parsed.data));
  }
  return entries;
}

export type PinTemplatesResult =
  | { readonly ok: true; readonly templates: LiveTemplate[] }
  | { readonly ok: false; readonly failure: UiResourceFailure; readonly uri: string };

/** For a first pin: all or nothing, like the tools. */
export function pinTemplates(entries: readonly LiveEntry[]): PinTemplatesResult {
  const templates: LiveTemplate[] = [];
  for (const entry of entries) {
    if ("invalid" in entry) return { ok: false, failure: entry.invalid, uri: entry.uri };
    templates.push(entry);
  }
  return { ok: true, templates };
}

export interface TemplateDrift {
  readonly templates: StoredTemplate[];
  /** URIs newly drifted or drifted further this pass; never content. */
  readonly changed: string[];
  readonly added: string[];
  readonly removed: string[];
}

const approvedOf = (t: StoredTemplate): StoredTemplate => {
  const { proposed: _proposed, ...rest } = t;
  return { ...rest, status: "pinned" };
};

const proposalOf = (live: LiveEntry): ProposedUiResource =>
  "invalid" in live
    ? { invalid: live.invalid }
    : {
        mime_type: live.mimeType,
        html: live.html,
        sha256: live.sha256,
        meta: live.meta,
        pinned_hash: live.pinnedHash,
      };

const sameProposal = (a: ProposedUiResource | undefined, b: ProposedUiResource): boolean =>
  a !== undefined &&
  ("invalid" in a
    ? "invalid" in b && a.invalid === b.invalid
    : !("invalid" in b) && a.pinned_hash === b.pinned_hash);

/** One stored template against its live entry; `undefined` removes it. */
function driftOne(
  stored: StoredTemplate,
  now: LiveEntry,
): { readonly next?: StoredTemplate; readonly changed: boolean } {
  if (stored.status === "drifted" && stored.proposed === undefined) {
    // New upstream and not yet approved: it follows the live bytes, and goes if they turn invalid.
    if ("invalid" in now) return { changed: false };
    return { next: { ...now, status: "drifted" }, changed: false };
  }
  if (!("invalid" in now) && now.pinnedHash === stored.pinnedHash) {
    return { next: approvedOf(stored), changed: false };
  }
  const proposal = proposalOf(now);
  if (sameProposal(stored.proposed, proposal)) return { next: stored, changed: false };
  return {
    next: { ...approvedOf(stored), status: "drifted", proposed: proposal },
    changed: true,
  };
}

/** Drift for templates, by the same rules as tools (`applyDrift`). */
export function applyTemplateDrift(
  current: readonly StoredTemplate[],
  live: readonly LiveEntry[],
): TemplateDrift {
  const liveByUri = new Map(live.map((t) => [t.uri, t]));
  const known = new Set(current.map((t) => t.uri));
  const result: TemplateDrift = { templates: [], changed: [], added: [], removed: [] };
  for (const stored of current) {
    const now = liveByUri.get(stored.uri);
    const step = now === undefined ? { changed: false } : driftOne(stored, now);
    if (step.next === undefined) result.removed.push(stored.uri);
    else result.templates.push(step.next);
    if (step.changed) result.changed.push(stored.uri);
  }
  for (const now of live) {
    if (known.has(now.uri) || "invalid" in now) continue;
    result.templates.push({ ...now, status: "drifted" });
    result.added.push(now.uri);
  }
  return result;
}
