import { createHash } from "node:crypto";
import {
  UI_RESOURCE_MAX_BYTES,
  UI_RESOURCE_META_MAX_BYTES,
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
  /** A site admin approved `html` (first pin or review); never true for a refresh-found row. */
  readonly approved: boolean;
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

/**
 * `_meta.ui` Postgres will store: no NUL anywhere and at most half the column's cap serialized
 * (jsonb's text form adds spaces, so the CHECK can never be the first to refuse it).
 */
function storableMeta(meta: UiResourceMeta): boolean {
  const text = JSON.stringify(meta);
  return (
    !text.includes("\\u0000") && Buffer.byteLength(text, "utf8") <= UI_RESOURCE_META_MAX_BYTES / 2
  );
}

function validate(entry: z.infer<typeof proxyEntrySchema>): LiveEntry {
  if ("error" in entry) return invalid(entry.uri, "ui_resource_invalid");
  if (entry.mimeType !== UI_RESOURCE_MIME_TYPE) return invalid(entry.uri, "ui_resource_invalid");
  // Lone surrogates are not UTF-8; Postgres refuses NUL in text and jsonb (review MEDIUM-1).
  if (/[\uD800-\uDFFF]/u.test(entry.text) || entry.text.includes("\0")) {
    return invalid(entry.uri, "ui_resource_invalid");
  }
  if (Buffer.byteLength(entry.text, "utf8") > UI_RESOURCE_MAX_BYTES) {
    return invalid(entry.uri, "ui_resource_invalid");
  }
  const hash = sha256(entry.text);
  const declared = declaredHash(entry.meta);
  if (declared !== undefined && declared !== hash) {
    return invalid(entry.uri, "ui_resource_hash_mismatch");
  }
  const ui = uiResourceMetaSchema.safeParse(entry.meta.ui ?? {});
  if (!ui.success || !storableMeta(ui.data)) return invalid(entry.uri, "ui_resource_invalid");
  const base = { uri: entry.uri, mimeType: entry.mimeType, sha256: hash, meta: ui.data };
  try {
    return { ...base, html: entry.text, pinnedHash: templatePinnedHash(base) };
  } catch {
    // canonicalJson refuses values JSON cannot carry (depth, non-finite numbers, ...).
    return invalid(entry.uri, "ui_resource_invalid");
  }
}

/**
 * Validates stored bytes again before approval (MA-2): the same checks as a probe, so an approval
 * can never pin something a probe would refuse. Returns the template with recomputed hashes.
 */
export function revalidate(t: {
  readonly uri: string;
  readonly mimeType: string;
  readonly html: string;
  readonly meta: UiResourceMeta;
}): LiveEntry {
  if (!UI_RESOURCE_URI_PATTERN.test(t.uri)) return invalid(t.uri, "ui_resource_invalid");
  return validate({ uri: t.uri, mimeType: t.mimeType, text: t.html, meta: { ui: t.meta } });
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

export interface InvalidReport {
  readonly uri: string;
  readonly reason: UiResourceFailure;
}

export interface TemplateDrift {
  readonly templates: StoredTemplate[];
  /** URIs newly drifted or drifted further this pass; never content. */
  readonly changed: string[];
  /** New upstream, or a new one whose live bytes became valid: awaiting a first approval. */
  readonly added: string[];
  readonly removed: string[];
  /** Live templates that cannot be pinned, newly so this pass (new or approved), with why. */
  readonly invalid: InvalidReport[];
}

type Step =
  | { readonly next: StoredTemplate; readonly event?: "changed" | "added" | "invalid" }
  | { readonly next?: undefined; readonly event?: undefined };

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

/**
 * A row for a new template whose live bytes cannot be pinned: an empty, never approved
 * placeholder carrying the reason, so the notice can show it and the event is not repeated.
 */
function placeholder(now: InvalidTemplate): StoredTemplate {
  const base = { uri: now.uri, mimeType: UI_RESOURCE_MIME_TYPE, sha256: sha256(""), meta: {} };
  return {
    ...base,
    html: "",
    pinnedHash: templatePinnedHash(base),
    status: "drifted",
    approved: false,
    proposed: { invalid: now.invalid },
  };
}

/** A template no site admin approved yet: it follows the live bytes and is never pinned here. */
function driftNew(stored: StoredTemplate, now: LiveEntry): Step {
  if ("invalid" in now) {
    if (sameProposal(stored.proposed, proposalOf(now))) return { next: stored };
    return { next: { ...stored, proposed: { invalid: now.invalid } }, event: "invalid" };
  }
  const next: StoredTemplate = { ...now, status: "drifted", approved: false };
  // It was invalid and now has bytes to review: a new template again.
  return stored.proposed === undefined ? { next } : { next, event: "added" };
}

function driftOne(stored: StoredTemplate, now: LiveEntry): Step {
  if (!stored.approved) return driftNew(stored, now);
  if (!("invalid" in now) && now.pinnedHash === stored.pinnedHash) {
    return { next: approvedOf(stored) };
  }
  const proposal = proposalOf(now);
  if (sameProposal(stored.proposed, proposal)) return { next: stored };
  return {
    next: { ...approvedOf(stored), status: "drifted", proposed: proposal },
    event: "invalid" in now ? "invalid" : "changed",
  };
}

const reasonOf = (t: StoredTemplate): UiResourceFailure =>
  t.proposed !== undefined && "invalid" in t.proposed ? t.proposed.invalid : "ui_resource_invalid";

/** Drift for templates, by the same rules as tools (`applyDrift`), plus invalid reports. */
export function applyTemplateDrift(
  current: readonly StoredTemplate[],
  live: readonly LiveEntry[],
): TemplateDrift {
  const liveByUri = new Map(live.map((t) => [t.uri, t]));
  const known = new Set(current.map((t) => t.uri));
  const result: TemplateDrift = {
    templates: [],
    changed: [],
    added: [],
    removed: [],
    invalid: [],
  };
  const record = (step: Step, uri: string) => {
    if (step.next === undefined) {
      result.removed.push(uri);
      return;
    }
    result.templates.push(step.next);
    if (step.event === "invalid") result.invalid.push({ uri, reason: reasonOf(step.next) });
    else if (step.event !== undefined) result[step.event].push(uri);
  };
  for (const stored of current) {
    const now = liveByUri.get(stored.uri);
    record(now === undefined ? {} : driftOne(stored, now), stored.uri);
  }
  for (const now of live) {
    if (known.has(now.uri)) continue;
    record(
      "invalid" in now
        ? { next: placeholder(now), event: "invalid" }
        : { next: { ...now, status: "drifted", approved: false }, event: "added" },
      now.uri,
    );
  }
  return result;
}
