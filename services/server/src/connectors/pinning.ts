import { and, connectors, eq, isNull, sql, type KobeDb, type UiResourceFailure } from "@kobe/db";
import { recordAudit } from "../audit/record.js";
import { buildSnapshot, type PinFailure } from "./pin.js";
import type { ConnectorProbe, ProbeFailure } from "./probe.js";
import { replacePinnedTemplates } from "./template-store.js";
import { liveTemplates, pinTemplates } from "./templates.js";

/**
 * Probes a registered connector through the MCP proxy and pins its tools (KOBE-101, D27). Pins are
 * written only while the connector has none (`tools_hash IS NULL`: new, or its URL just changed and
 * cleared them) and still has the probed URL, so a probe never overwrites reviewed pins and a
 * slow probe of an old URL cannot pin the wrong server's tools. Changing pins that exist is the
 * drift re-approval flow (later tickets).
 *
 * The `ui://` templates the tools name (MCP Apps, KOBE-433) are pinned in the same transaction,
 * hashed by Kobe; a template that fails validation (size, type, encoding, a `contentHash` that
 * does not match) fails the whole pin with its code, like a tool that cannot be pinned.
 */
export type PinOutcome =
  | { readonly ok: true; readonly tools: number; readonly templates: number }
  | {
      readonly ok: false;
      readonly failure:
        ProbeFailure | PinFailure | UiResourceFailure | "already_pinned" | "changed";
    };

export async function pinConnector(
  db: KobeDb,
  prober: ConnectorProbe,
  connectorId: string,
  options: {
    /**
     * The probe's credential, asked for only when a probe will run (`adminPinCredential` in
     * probe-credential.ts, which also audits the choice); used for this probe only.
     */
    readonly credential?: (connector: {
      readonly id: string;
      readonly name: string;
    }) => Promise<string | undefined>;
    /** The site admin pinning: their own key probes the periodic refresh (KOBE-431). */
    readonly pinnedBy?: string | undefined;
  } = {},
): Promise<PinOutcome | undefined> {
  const [row] = await db
    .select({ name: connectors.name, url: connectors.url, hash: connectors.toolsHash })
    .from(connectors)
    .where(and(eq(connectors.id, connectorId), isNull(connectors.deletedAt)));
  if (!row) return undefined;
  if (row.hash !== null) return { ok: false, failure: "already_pinned" };

  const apiKey = await options.credential?.({ id: connectorId, name: row.name });
  const probed = await prober.probe(row.url, apiKey);
  if (!probed.ok) return probed;
  const snapshot = buildSnapshot(row.name, probed.tools);
  if (!snapshot.ok) return snapshot;
  const templates = pinTemplates(liveTemplates(snapshot.tools, probed.uiResources ?? []));
  if (!templates.ok) return { ok: false, failure: templates.failure };

  return db.transaction(async (tx): Promise<PinOutcome> => {
    const written = await tx
      .update(connectors)
      .set({
        toolsSnapshot: snapshot.tools,
        toolsHash: snapshot.hash,
        ...(options.pinnedBy === undefined ? {} : { pinnedBy: options.pinnedBy }),
        refreshSkipped: null,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(connectors.id, connectorId),
          eq(connectors.url, row.url),
          isNull(connectors.toolsHash),
          isNull(connectors.deletedAt),
        ),
      )
      .returning({ id: connectors.id });
    if (written.length === 0) return { ok: false, failure: "changed" };
    await replacePinnedTemplates(tx, connectorId, templates.templates, options.pinnedBy);
    await recordAudit(tx, {
      action: "mcp.connector.pinned",
      target: {
        connectorId,
        name: row.name,
        tools: snapshot.tools.length,
        hash: snapshot.hash,
        ...(templates.templates.length === 0
          ? {}
          : { templates: templates.templates.map((t) => ({ uri: t.uri, sha256: t.sha256 })) }),
      },
    });
    return { ok: true, tools: snapshot.tools.length, templates: templates.templates.length };
  });
}
