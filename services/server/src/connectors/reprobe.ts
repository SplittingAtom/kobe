import { and, connectors, eq, isNull, type Envelope, type KobeDb } from "@kobe/db";
import { recordAuditAfter } from "../audit/record.js";
import { hitRateLimit, type RateLimitRule } from "../rate-limit.js";
import type { ReconcileLock } from "../sandbox/reconcile-lock.js";
import { pinConnector } from "./pinning.js";
import type { ConnectorProbe } from "./probe.js";
import {
  adminPinCredential,
  chooseProbeCredential,
  nextPinnedBy,
  type ProbeCredential,
} from "./probe-credential.js";
import { refreshConnector, type RefreshOutcome } from "./refresh.js";

/**
 * Re-probe now (KOBE-430): a site admin runs the periodic refresh's probe and drift (D27,
 * {@link refreshConnector}) for one connector instead of waiting for the next pass. A connector
 * with no pins goes through the pin path. It runs under the connector's own refresh lock (the
 * periodic pass skips a connector it finds locked, and a Re-probe finds a pass busy), is
 * rate-limited per connector, and is audited as `mcp.connector.refreshed` with counts only.
 *
 * The probe credential is the acting admin's (the site key, else their own key), else that of
 * the admin who last pinned or approved it (KOBE-431's rule): never a member's.
 */
export const REPROBE_RATE: RateLimitRule = { windowMs: 10 * 60_000, max: 5 };

export interface TemplateCounts {
  readonly changed: number;
  readonly added: number;
  readonly removed: number;
  readonly invalid: number;
}

export type ReprobeOutcome =
  | { readonly status: "unchanged" }
  | {
      readonly status: "drifted";
      readonly changed: number;
      readonly added: number;
      readonly removed: number;
      readonly templates: TemplateCounts;
    }
  | { readonly status: "pinned"; readonly tools: number; readonly templates: number }
  | { readonly status: "failed"; readonly reason: string };

export type ReprobeResult =
  | { readonly kind: "not_found" }
  | { readonly kind: "disabled" }
  | { readonly kind: "rate_limited" }
  | { readonly kind: "busy" }
  | { readonly kind: "done"; readonly outcome: ReprobeOutcome };

export interface ReprobeDeps {
  readonly db: KobeDb;
  readonly prober: ConnectorProbe;
  readonly envelope: Envelope | undefined;
  readonly lockFor: (connectorId: string) => ReconcileLock;
  readonly rate?: RateLimitRule;
}

interface Probed {
  readonly outcome: ReprobeOutcome;
  /** The credential the refresh used (the pin path audits its own choice). */
  readonly credential?: ProbeCredential;
}

/** The acting admin's credential, else the pinning admin's (both by KOBE-431's rule). */
async function reprobeCredential(
  deps: ReprobeDeps,
  connectorId: string,
  adminId: string,
): Promise<ProbeCredential> {
  const own = await chooseProbeCredential(deps.db, deps.envelope, connectorId, adminId);
  if (own.source !== "none") return own;
  return chooseProbeCredential(deps.db, deps.envelope, connectorId, "pinned_by");
}

const fromRefresh = (outcome: RefreshOutcome): ReprobeOutcome => {
  if (outcome.status === "skipped") return { status: "failed", reason: outcome.reason };
  if (outcome.status === "unchanged") return { status: "unchanged" };
  const { changed, added, removed, templates } = outcome;
  return { status: "drifted", changed, added, removed, templates };
};

async function pinNow(
  deps: ReprobeDeps,
  connectorId: string,
  adminId: string,
): Promise<Probed | undefined> {
  const pin = await pinConnector(deps.db, deps.prober, connectorId, {
    credential: adminPinCredential(deps.db, deps.envelope, adminId),
    pinnedBy: await nextPinnedBy(deps.db, deps.envelope, connectorId, adminId),
  });
  if (pin === undefined) return { outcome: { status: "failed", reason: "not_found" } };
  if (pin.ok) return { outcome: { status: "pinned", tools: pin.tools, templates: pin.templates } };
  // Pinned meanwhile: refresh it like any pinned connector.
  if (pin.failure === "already_pinned") return undefined;
  return { outcome: { status: "failed", reason: pin.failure } };
}

async function probeNow(
  deps: ReprobeDeps,
  connectorId: string,
  adminId: string,
  unpinned: boolean,
): Promise<Probed> {
  if (unpinned) {
    const pinned = await pinNow(deps, connectorId, adminId);
    if (pinned) return pinned;
  }
  const credential = await reprobeCredential(deps, connectorId, adminId);
  const outcome = await refreshConnector(deps.db, deps.prober, connectorId, {
    envelope: deps.envelope,
    credential,
  });
  return { outcome: fromRefresh(outcome), credential };
}

const counts = (outcome: ReprobeOutcome) => {
  if (outcome.status === "drifted") {
    return { changed: outcome.changed, added: outcome.added, removed: outcome.removed };
  }
  const added = outcome.status === "pinned" ? outcome.tools : 0;
  return { changed: 0, added, removed: 0 };
};

/** Counts and the credential's kind only: no tool names, URLs or keys. */
function auditReprobe(
  db: KobeDb,
  connector: { readonly id: string; readonly name: string },
  probed: Probed,
): Promise<void> {
  const { outcome, credential } = probed;
  return recordAuditAfter(db, {
    action: "mcp.connector.refreshed",
    target: {
      connectorId: connector.id,
      name: connector.name,
      outcome: outcome.status,
      ...(outcome.status === "failed" ? { reason: outcome.reason } : {}),
      ...counts(outcome),
      ...(credential === undefined ? {} : { credential: credential.source }),
      ...(credential?.adminId === undefined ? {} : { adminId: credential.adminId }),
    },
  });
}

export async function reprobeConnector(
  deps: ReprobeDeps,
  connectorId: string,
  adminId: string,
): Promise<ReprobeResult> {
  const [row] = await deps.db
    .select({ name: connectors.name, status: connectors.status, hash: connectors.toolsHash })
    .from(connectors)
    .where(and(eq(connectors.id, connectorId), isNull(connectors.deletedAt)));
  if (!row) return { kind: "not_found" };
  if (row.status !== "active") return { kind: "disabled" };
  const rate = deps.rate ?? REPROBE_RATE;
  if (!(await hitRateLimit(deps.db, `connector-reprobe:${connectorId}`, rate))) {
    return { kind: "rate_limited" };
  }
  const locked = await deps
    .lockFor(connectorId)
    .runExclusive(() => probeNow(deps, connectorId, adminId, row.hash === null));
  if (!locked.ran) return { kind: "busy" };
  await auditReprobe(deps.db, { id: connectorId, name: row.name }, locked.value);
  return { kind: "done", outcome: locked.value.outcome };
}
