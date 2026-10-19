import {
  SYSTEM_ACTOR,
  and,
  connectors,
  eq,
  isNotNull,
  isNull,
  parseToolsSnapshot,
  sql,
  type Envelope,
  type KobeDb,
  type KobeTx,
} from "@kobe/db";
import { canonicalJson } from "@kobe/protocol";
import type { Logger } from "pino";
import { recordAudit } from "../audit/record.js";
import { logger } from "../logger.js";
import type { ReconcileLock } from "../sandbox/reconcile-lock.js";
import { applyDrift, approvedHash } from "./drift.js";
import { buildSnapshot } from "./pin.js";
import type { ConnectorProbe } from "./probe.js";
import { auditProbeCredential, chooseProbeCredential } from "./probe-credential.js";
import { loadTemplates, writeTemplateDrift } from "./template-store.js";
import {
  applyTemplateDrift,
  liveTemplates,
  type LiveEntry,
  type TemplateDrift,
} from "./templates.js";

/**
 * Periodic refresh (KOBE-102, spec D27): re-probes every pinned, active connector through the MCP
 * proxy and applies {@link applyDrift}. A connector whose probe fails, or whose live list cannot be
 * pinned unambiguously, keeps its snapshot as it was (a failure never offers anything new). One
 * server replica at a time runs a pass (advisory lock); a connector is written only if it still
 * has the probed URL, under a row lock, so an admin edit during the probe wins.
 *
 * A connector that needs a credential is probed with the one {@link chooseProbeCredential} picks
 * (KOBE-431: its site-wide key, else the own key of the site admin who last pinned or approved
 * it; never a member's). Each pass records when it probed and, if it skipped, why
 * (`refresh_skipped`, shown on the connector page); the start of an `auth_required` skip is an
 * `mcp.connector.refresh_skipped` event, which site admins are emailed about.
 *
 * The same probe re-reads the connector's MCP Apps `ui://` templates (KOBE-433) and applies
 * {@link applyTemplateDrift} to them in the same transaction, so a skip (`auth_required` or any
 * failure) leaves the templates exactly as they were, like the tools. Template trouble never
 * stops the tools' refresh: when the proxy skipped the template part, or writing the templates
 * fails (a savepoint), the tools still refresh and the outcome says `templatesSkipped`.
 */
export const CONNECTOR_REFRESH_LOCK = "kobe.connector-refresh";

/** Why the template part of a pass did not run (the tools still refreshed). */
interface TemplatesSkipped {
  readonly templatesSkipped?: string;
}

export type RefreshOutcome =
  | ({ readonly status: "unchanged" } & TemplatesSkipped)
  | ({
      readonly status: "drifted";
      readonly changed: number;
      readonly added: number;
      readonly removed: number;
      readonly templates: {
        readonly changed: number;
        readonly added: number;
        readonly removed: number;
        readonly invalid: number;
      };
    } & TemplatesSkipped)
  | { readonly status: "skipped"; readonly reason: string };

const NO_TEMPLATE_DRIFT: Omit<TemplateDrift, "templates"> = {
  changed: [],
  added: [],
  removed: [],
  invalid: [],
};

const skipped = (reason: string): RefreshOutcome => ({ status: "skipped", reason });

const refreshable = (connectorId: string) =>
  and(
    eq(connectors.id, connectorId),
    eq(connectors.status, "active"),
    isNull(connectors.deletedAt),
    isNotNull(connectors.toolsHash),
  );

export interface RefreshOptions {
  /** Opens the site key or the admin's key; without it only unauthenticated probes run. */
  readonly envelope?: Envelope | undefined;
}

/** Records a skipped pass on the row (if it still has the probed URL) and the start of a skip. */
async function recordSkip(
  db: KobeDb,
  connectorId: string,
  probed: { readonly url: string; readonly name: string },
  reason: string,
): Promise<RefreshOutcome> {
  await db.transaction(async (tx) => {
    const [locked] = await tx
      .select({ url: connectors.url, skipped: connectors.refreshSkipped })
      .from(connectors)
      .where(refreshable(connectorId))
      .for("update");
    if (!locked || locked.url !== probed.url) return;
    await tx
      .update(connectors)
      .set({ refreshSkipped: reason, refreshedAt: sql`now()` })
      .where(eq(connectors.id, connectorId));
    if (reason === "auth_required" && locked.skipped !== reason) {
      await recordAudit(tx, {
        action: "mcp.connector.refresh_skipped",
        actor: SYSTEM_ACTOR,
        target: { connectorId, name: probed.name, reason },
      });
    }
  });
  return skipped(reason);
}

/** A checked pass: no tool skip, the snapshot is post-433 now, and the template skip (if any). */
const passState = (templatesSkipped: string | undefined) => ({
  refreshSkipped: null,
  refreshedAt: sql`now()`,
  pinVersion: 2,
  templatesSkipped: templatesSkipped ?? null,
});

const markRefreshed = (tx: KobeTx, connectorId: string, templatesSkipped: string | undefined) =>
  tx.update(connectors).set(passState(templatesSkipped)).where(eq(connectors.id, connectorId));

/**
 * The start of a template skip (or a new reason) is audited and warned about, so site admins are
 * told like an `auth_required` skip (re-review NEW-2); a repeat is not.
 */
async function noteTemplatesSkipped(
  tx: KobeTx,
  connector: { readonly id: string; readonly name: string; readonly before: string | null },
  reason: string | undefined,
): Promise<void> {
  if (reason === undefined || reason === connector.before) return;
  logger.warn({ connectorId: connector.id, reason }, "connector templates not checked for changes");
  await recordAudit(tx, {
    action: "mcp.connector.templates_skipped",
    actor: SYSTEM_ACTOR,
    target: { connectorId: connector.id, name: connector.name, reason },
  });
}

export async function refreshConnector(
  db: KobeDb,
  prober: ConnectorProbe,
  connectorId: string,
  options: RefreshOptions = {},
): Promise<RefreshOutcome> {
  const [row] = await db
    .select({ name: connectors.name, url: connectors.url })
    .from(connectors)
    .where(refreshable(connectorId));
  if (!row) return skipped("not_pinned");

  const credential = await chooseProbeCredential(db, options.envelope, connectorId, "pinned_by");
  await auditProbeCredential(db, { id: connectorId, name: row.name }, "refresh", credential);
  const probed = await prober.probe(row.url, credential.apiKey);
  if (!probed.ok) return recordSkip(db, connectorId, row, probed.failure);
  const live = buildSnapshot(row.name, probed.tools);
  if (!live.ok) return recordSkip(db, connectorId, row, live.failure);
  // A prober that reports no templates, or skipped them, leaves them alone.
  const liveUi: LiveEntry[] | undefined =
    probed.uiResources === undefined ? undefined : liveTemplates(live.tools, probed.uiResources);
  const uiSkipped = probed.uiSkipped === undefined ? {} : { templatesSkipped: probed.uiSkipped };

  return db.transaction(async (tx): Promise<RefreshOutcome> => {
    const [locked] = await tx
      .select({
        url: connectors.url,
        name: connectors.name,
        snapshot: connectors.toolsSnapshot,
        pinVersion: connectors.pinVersion,
        templatesSkipped: connectors.templatesSkipped,
      })
      .from(connectors)
      .where(refreshable(connectorId))
      .for("update");
    if (!locked || locked.url !== row.url) return skipped("changed");

    const before = parseToolsSnapshot(locked.snapshot);
    const drift = applyDrift(before, live.tools, { adoptLegacyUi: locked.pinVersion === 1 });
    const templates =
      liveUi === undefined ? undefined : await driftTemplates(tx, connectorId, liveUi);
    const ui = templates?.ok ? templates.drift : NO_TEMPLATE_DRIFT;
    const notes = templates?.ok === false ? { templatesSkipped: "write_failed" } : uiSkipped;
    await noteTemplatesSkipped(
      tx,
      { id: connectorId, name: locked.name, before: locked.templatesSkipped },
      notes.templatesSkipped,
    );
    const toolEvents = drift.changed.length + drift.added.length + drift.removed.length;
    const templateEvents =
      ui.changed.length + ui.added.length + ui.removed.length + ui.invalid.length;
    const toolsSame = canonicalJson(drift.tools) === canonicalJson(before);
    // A drifted tool returning to its approval rewrites the rows without being an event.
    if (toolEvents + templateEvents === 0 && toolsSame) {
      await markRefreshed(tx, connectorId, notes.templatesSkipped);
      return { status: "unchanged", ...notes };
    }
    await tx
      .update(connectors)
      .set({
        toolsSnapshot: drift.tools,
        toolsHash: approvedHash(drift.tools),
        ...passState(notes.templatesSkipped),
        updatedAt: sql`now()`,
      })
      .where(eq(connectors.id, connectorId));
    if (toolEvents + templateEvents === 0) return { status: "unchanged", ...notes };
    await recordAudit(tx, {
      action: "mcp.connector.drift",
      actor: SYSTEM_ACTOR,
      target: {
        connectorId,
        name: locked.name,
        changed: drift.changed,
        added: drift.added,
        removed: drift.removed,
        templates: {
          changed: ui.changed,
          added: ui.added,
          removed: ui.removed,
          invalid: ui.invalid,
        },
      },
    });
    return {
      status: "drifted",
      changed: drift.changed.length,
      added: drift.added.length,
      removed: drift.removed.length,
      templates: {
        changed: ui.changed.length,
        added: ui.added.length,
        removed: ui.removed.length,
        invalid: ui.invalid.length,
      },
      ...notes,
    };
  });
}

/**
 * Template drift under the connector's row lock, in a savepoint: if writing them fails, the
 * templates stay as they were and the tools' refresh goes on (review MEDIUM-1).
 */
async function driftTemplates(
  tx: KobeTx,
  connectorId: string,
  live: readonly LiveEntry[],
): Promise<{ readonly ok: true; readonly drift: TemplateDrift } | { readonly ok: false }> {
  try {
    return await tx.transaction(async (sp) => {
      const stored = await loadTemplates(sp, connectorId, { forUpdate: true });
      const drift = applyTemplateDrift(stored, live);
      await writeTemplateDrift(sp, connectorId, stored, drift.templates);
      return { ok: true as const, drift };
    });
  } catch (err) {
    logger.warn({ err, connectorId }, "connector template refresh failed; tools still refreshed");
    return { ok: false };
  }
}

export interface RefreshSummary {
  readonly checked: number;
  readonly drifted: number;
  readonly skipped: number;
  readonly failed: number;
}

/** One pass over every pinned, active connector. A failure on one is logged, never stops the rest. */
export async function refreshAllConnectors(
  db: KobeDb,
  prober: ConnectorProbe,
  logger: Pick<Logger, "warn" | "info">,
  options: RefreshOptions = {},
): Promise<RefreshSummary> {
  const ids = await db
    .select({ id: connectors.id })
    .from(connectors)
    .where(
      and(
        eq(connectors.status, "active"),
        isNull(connectors.deletedAt),
        isNotNull(connectors.toolsHash),
      ),
    );
  let drifted = 0;
  let skippedCount = 0;
  let failed = 0;
  for (const { id } of ids) {
    try {
      const outcome = await refreshConnector(db, prober, id, options);
      if (outcome.status === "drifted") drifted += 1;
      if (outcome.status === "skipped") {
        skippedCount += 1;
        logger.info({ connectorId: id, reason: outcome.reason }, "connector refresh skipped");
      }
    } catch (err) {
      failed += 1;
      logger.warn({ err, connectorId: id }, "connector refresh failed");
    }
  }
  return { checked: ids.length, drifted, skipped: skippedCount, failed };
}

export interface ConnectorRefreshOptions {
  readonly db: KobeDb;
  readonly prober: ConnectorProbe;
  readonly lock: ReconcileLock;
  readonly intervalMs: number;
  readonly logger: Logger;
  /** Opens probe credentials (KOBE-431); unset: auth-required connectors are skipped. */
  readonly envelope?: Envelope | undefined;
  /** After each pass (KOBE-103): emails about drift. Must not throw. */
  readonly afterPass?: () => Promise<unknown>;
}

/** Starts the interval; returns the stop function. `intervalMs <= 0` starts nothing. */
export function startConnectorRefresh(options: ConnectorRefreshOptions): () => void {
  if (options.intervalMs <= 0) return () => undefined;
  let running = false;
  const run = () => {
    if (running) return;
    running = true;
    options.lock
      .runExclusive(async () => {
        const summary = await refreshAllConnectors(options.db, options.prober, options.logger, {
          envelope: options.envelope,
        });
        await options.afterPass?.();
        return summary;
      })
      .then((outcome) => {
        if (outcome.ran) options.logger.info(outcome.value, "connectors refreshed");
      })
      .catch((err: unknown) => options.logger.warn({ err }, "connector refresh pass failed"))
      .finally(() => {
        running = false;
      });
  };
  const timer = setInterval(run, options.intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
