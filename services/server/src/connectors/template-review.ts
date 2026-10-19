import { z } from "zod";
import {
  and,
  connectorUiResources,
  connectors,
  eq,
  isNull,
  sql,
  type KobeDb,
  type UiResourceFailure,
  type UiResourceMeta,
} from "@kobe/db";
import { recordAudit } from "../audit/record.js";
import { loadTemplates } from "./template-store.js";
import { revalidate, type StoredTemplate } from "./templates.js";

/**
 * Site-admin review and approval of MCP Apps templates (KOBE-434, spec mcp-apps-host §5). The
 * review shows each template's approved and live versions (hashes, size, declared `_meta.ui`);
 * the bytes come from a separate JSON endpoint for the escaped source diff and the stubbed
 * preview. Approving names each template with the `pinned_hash` the admin reviewed, so one that
 * changed again is refused (`stale`), and the bytes are validated again before they are pinned.
 * An invalid live template (or the placeholder of an invalid new one) can never be approved.
 */
export const approveTemplatesSchema = z.strictObject({
  templates: z
    .array(
      z.strictObject({
        uri: z.string().min(1).max(2048),
        pinnedHash: z.string().regex(/^[0-9a-f]{64}$/),
      }),
    )
    .min(1)
    .max(64),
});
export type ApproveTemplatesInput = z.infer<typeof approveTemplatesSchema>;

export interface TemplateVersion {
  readonly sha256: string;
  readonly pinnedHash: string;
  /** UTF-8 bytes of the template. */
  readonly bytes: number;
  readonly mimeType: string;
  /** The declared `_meta.ui` (csp, permissions, domain, prefersBorder); ignored when rendering. */
  readonly meta: UiResourceMeta;
}

export interface TemplateReview {
  readonly uri: string;
  readonly status: "pinned" | "drifted";
  /** `changed`: approved bytes differ from the live ones; `added`: new; `invalid`: cannot pin. */
  readonly change: "changed" | "added" | "invalid" | null;
  readonly approved?: TemplateVersion;
  /** The live version awaiting approval; send its `pinnedHash` back to approve it. */
  readonly live?: TemplateVersion;
  readonly invalid?: UiResourceFailure;
}

const version = (t: {
  sha256: string;
  pinnedHash: string;
  html: string;
  mimeType: string;
  meta: UiResourceMeta;
}): TemplateVersion => ({
  sha256: t.sha256,
  pinnedHash: t.pinnedHash,
  bytes: Buffer.byteLength(t.html, "utf8"),
  mimeType: t.mimeType,
  meta: t.meta,
});

/** The proposed bytes of a drifted, approved row, as a template. */
const proposedOf = (t: StoredTemplate) =>
  t.proposed !== undefined && !("invalid" in t.proposed)
    ? {
        uri: t.uri,
        mimeType: t.proposed.mime_type,
        html: t.proposed.html,
        sha256: t.proposed.sha256,
        meta: t.proposed.meta,
        pinnedHash: t.proposed.pinned_hash,
      }
    : undefined;

const invalidOf = (t: StoredTemplate): UiResourceFailure | undefined =>
  t.proposed !== undefined && "invalid" in t.proposed ? t.proposed.invalid : undefined;

export function reviewOfTemplate(t: StoredTemplate): TemplateReview {
  const base = { uri: t.uri, status: t.status };
  if (t.status === "pinned") return { ...base, change: null, approved: version(t) };
  const invalid = invalidOf(t);
  const approved = t.approved ? { approved: version(t) } : {};
  if (invalid !== undefined) return { ...base, change: "invalid", ...approved, invalid };
  if (!t.approved) return { ...base, change: "added", live: version(t) };
  const live = proposedOf(t);
  return { ...base, change: "changed", ...approved, ...(live ? { live: version(live) } : {}) };
}

/** One version's bytes with the hashes and meta read together with them (review M1). */
export interface SourceVersion extends TemplateVersion {
  readonly html: string;
}

/**
 * What the review's source diff needs: the bytes, as JSON text, never as HTML, each with its own
 * hashes and declared meta from the same read. The web approves with `live.pinnedHash` from here,
 * so an admin approves exactly the bytes they were shown (or gets `stale`).
 */
export interface TemplateSource {
  readonly uri: string;
  readonly approved?: SourceVersion;
  readonly live?: SourceVersion;
}

const withHtml = (t: Parameters<typeof version>[0]): SourceVersion => ({
  ...version(t),
  html: t.html,
});

export function sourceOfTemplate(t: StoredTemplate): TemplateSource {
  const live = invalidOf(t) === undefined ? candidateOf(t) : undefined;
  return {
    uri: t.uri,
    ...(t.approved ? { approved: withHtml(t) } : {}),
    ...(live === undefined ? {} : { live: withHtml(live) }),
  };
}

/** The bytes the admin preview frame shows (`version` live or approved), if any. */
export function frameHtmlOf(t: StoredTemplate, which: "live" | "approved"): string | undefined {
  return sourceOfTemplate(t)[which]?.html;
}

export type TemplateApproval =
  | { readonly ok: true; readonly templates: StoredTemplate[] }
  | {
      readonly ok: false;
      readonly error: "not_pending" | "stale" | "invalid";
      readonly uri: string;
    };

/** The template a request approves: the live bytes of a changed or new row. */
function candidateOf(t: StoredTemplate) {
  if (invalidOf(t) !== undefined) return undefined;
  return t.approved ? proposedOf(t) : t;
}

/** All or nothing (pure). Returns only the approved templates, ready to store. */
export function approveTemplatesPure(
  current: readonly StoredTemplate[],
  requests: ApproveTemplatesInput["templates"],
): TemplateApproval {
  const approved: StoredTemplate[] = [];
  for (const { uri, pinnedHash } of requests) {
    const row = current.find((t) => t.uri === uri);
    if (!row || row.status !== "drifted") return { ok: false, error: "not_pending", uri };
    const candidate = candidateOf(row);
    if (!candidate) return { ok: false, error: "invalid", uri };
    if (candidate.pinnedHash !== pinnedHash) return { ok: false, error: "stale", uri };
    const checked = revalidate(candidate);
    if ("invalid" in checked || checked.pinnedHash !== pinnedHash) {
      return { ok: false, error: "invalid", uri };
    }
    approved.push({ ...checked, status: "pinned", approved: true });
  }
  return { ok: true, templates: approved };
}

const live = (connectorId: string) =>
  and(eq(connectors.id, connectorId), isNull(connectors.deletedAt));

export async function reviewConnectorTemplates(
  db: KobeDb,
  connectorId: string,
): Promise<TemplateReview[] | undefined> {
  const [row] = await db.select({ id: connectors.id }).from(connectors).where(live(connectorId));
  if (!row) return undefined;
  return (await loadTemplates(db, connectorId)).map(reviewOfTemplate);
}

async function storedTemplate(
  db: KobeDb,
  connectorId: string,
  uri: string,
): Promise<StoredTemplate | undefined> {
  const [row] = await db.select({ id: connectors.id }).from(connectors).where(live(connectorId));
  if (!row) return undefined;
  return (await loadTemplates(db, connectorId)).find((t) => t.uri === uri);
}

/** The admin preview's bytes (review M2): served only by the site-admin frame route. */
export async function connectorTemplateFrame(
  db: KobeDb,
  connectorId: string,
  uri: string,
  which: "live" | "approved",
): Promise<string | undefined> {
  const found = await storedTemplate(db, connectorId, uri);
  return found ? frameHtmlOf(found, which) : undefined;
}

export async function connectorTemplateSource(
  db: KobeDb,
  connectorId: string,
  uri: string,
): Promise<TemplateSource | undefined> {
  const found = await storedTemplate(db, connectorId, uri);
  return found ? sourceOfTemplate(found) : undefined;
}

export type TemplateApprovalOutcome =
  | { readonly ok: true; readonly approved: string[] }
  | { readonly ok: false; readonly error: "not_found" }
  | Extract<TemplateApproval, { ok: false }>;

export async function approveConnectorTemplates(
  db: KobeDb,
  connectorId: string,
  input: ApproveTemplatesInput,
  adminId: string,
): Promise<TemplateApprovalOutcome> {
  return db.transaction(async (tx): Promise<TemplateApprovalOutcome> => {
    const [row] = await tx
      .select({ name: connectors.name })
      .from(connectors)
      .where(live(connectorId))
      .for("update");
    if (!row) return { ok: false, error: "not_found" };
    const stored = await loadTemplates(tx, connectorId, { forUpdate: true });
    const result = approveTemplatesPure(stored, input.templates);
    if (!result.ok) return result;
    for (const t of result.templates) {
      await tx
        .update(connectorUiResources)
        .set({
          mimeType: t.mimeType,
          html: t.html,
          sha256: t.sha256,
          meta: t.meta,
          pinnedHash: t.pinnedHash,
          status: "pinned",
          approved: true,
          proposed: null,
          pinnedBy: adminId,
          pinnedAt: sql`now()`,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(connectorUiResources.connectorId, connectorId),
            eq(connectorUiResources.uri, t.uri),
          ),
        );
    }
    await recordAudit(tx, {
      action: "mcp.connector.reapproved",
      target: {
        connectorId,
        name: row.name,
        tools: [],
        templates: result.templates.map((t) => ({ uri: t.uri, sha256: t.sha256 })),
      },
    });
    return { ok: true, approved: result.templates.map((t) => t.uri) };
  });
}
