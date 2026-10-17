/**
 * Site console: the site-wide audit log (`/v1/site/audit`, site.audit.read; KOBE-15, KOBE-17).
 * Read-only: the list (newest first, keyset paged by `seq`, filtered by the server) and the
 * full-chain integrity check. Responses arrive camelized.
 */
import { apiRequest, type ApiResult } from "../../../api/client";

/** The event categories the server filters on (docs/audit-log.md, "Reading the log"). */
export const AUDIT_CATEGORIES = [
  "agent",
  "approval",
  "audit",
  "auth",
  "egress",
  "governance",
  "identity",
  "models",
  "platform",
  "policy",
  "run",
  "sandbox",
  "site",
  "thread",
  "workspace",
] as const;

export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];

/** An action name as the server records it: `sandbox.runtime_tampered`. */
export const AUDIT_ACTION_PATTERN = /^[a-z][a-z_]*(\.[a-z][a-z_]*)+$/;

export interface SiteAuditEvent {
  readonly id: string;
  readonly seq: number;
  readonly at: string;
  /** Null for site-level events. */
  readonly teamId: string | null;
  readonly actor: {
    readonly kind: "user" | "agent" | "system";
    readonly id: string | null;
    readonly name: string | null;
    readonly email: string | null;
  };
  readonly action: string;
  /** The event's allowlisted fields (strict per action on the server); shown as plain text. */
  readonly target: Record<string, unknown>;
  /** Null once erased (after the site's retention period) or when the request had none. */
  readonly ip: string | null;
  readonly userAgent: string | null;
}

export interface SiteAuditPage {
  readonly events: readonly SiteAuditEvent[];
  readonly nextCursor: string | null;
}

/** Server-side filters; all optional. Times are ISO date-times. */
export interface AuditFilters {
  readonly action?: string;
  readonly category?: AuditCategory;
  readonly actorId?: string;
  readonly teamId?: string;
  readonly since?: string;
  readonly until?: string;
}

export const AUDIT_PAGE_SIZE = 50;

const FILTER_KEYS = ["action", "category", "actorId", "teamId", "since", "until"] as const;

/** `?limit=50&action=…&before=…`: only the filters that are set, in a fixed order. */
export function auditQuery(filters: AuditFilters, before?: string | null, limit = AUDIT_PAGE_SIZE) {
  const params = new URLSearchParams({ limit: String(limit) });
  for (const key of FILTER_KEYS) {
    const value = filters[key];
    if (value) params.set(key, value);
  }
  if (before) params.set("before", before);
  return `?${params.toString()}`;
}

/** Keeps only the fields the page shows, so nothing else the server might add is rendered. */
function pick(e: SiteAuditEvent): SiteAuditEvent {
  return {
    id: e.id,
    seq: e.seq,
    at: e.at,
    teamId: e.teamId ?? null,
    actor: {
      kind: e.actor.kind,
      id: e.actor.id ?? null,
      name: e.actor.name ?? null,
      email: e.actor.email ?? null,
    },
    action: e.action,
    target: e.target && typeof e.target === "object" ? e.target : {},
    ip: e.ip ?? null,
    userAgent: e.userAgent ?? null,
  };
}

export async function listSiteAudit(
  filters: AuditFilters = {},
  before?: string | null,
  limit = AUDIT_PAGE_SIZE,
): Promise<ApiResult<SiteAuditPage>> {
  const res = await apiRequest<SiteAuditPage>(
    `/v1/site/audit${auditQuery(filters, before, limit)}`,
  );
  return res.ok
    ? { ...res, data: { events: res.data.events.map(pick), nextCursor: res.data.nextCursor } }
    : res;
}

/** Why a chain check failed (packages/db/src/audit/verify.ts). */
export type AuditChainProblem =
  "gap" | "prev_hash_mismatch" | "hash_mismatch" | "pii_mismatch" | "seal_mismatch" | "extra_seal";

export interface AuditIntegrity {
  readonly ok: boolean;
  readonly checked: number;
  readonly head: { readonly seq: number; readonly hash: string } | null;
  readonly problem?: { readonly seq: number; readonly kind: AuditChainProblem };
  /** The head attested by the server (HMAC under a key outside the database). */
  readonly anchor: {
    readonly seq: number;
    readonly hash: string;
    readonly at: string;
    readonly mac: string;
  } | null;
}

/** Recomputes the whole chain (3 per minute per admin: the server answers 429 beyond that). */
export function checkAuditIntegrity(): Promise<ApiResult<AuditIntegrity>> {
  return apiRequest("/v1/site/audit/integrity");
}
