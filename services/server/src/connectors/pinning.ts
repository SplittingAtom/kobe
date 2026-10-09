import { and, connectors, eq, isNull, sql, type KobeDb } from "@kobe/db";
import { recordAudit } from "../audit/record.js";
import { buildSnapshot, type PinFailure } from "./pin.js";
import type { ConnectorProbe, ProbeFailure } from "./probe.js";

/**
 * Probes a registered connector through the MCP proxy and pins its tools (KOBE-101, D27). Pins are
 * written only while the connector has none (`tools_hash IS NULL`: new, or its URL just changed and
 * cleared them) and still has the probed URL, so a probe never overwrites reviewed pins and a
 * slow probe of an old URL cannot pin the wrong server's tools. Changing pins that exist is the
 * drift re-approval flow (later tickets).
 */
export type PinOutcome =
  | { readonly ok: true; readonly tools: number }
  | {
      readonly ok: false;
      readonly failure: ProbeFailure | PinFailure | "already_pinned" | "changed";
    };

export async function pinConnector(
  db: KobeDb,
  prober: ConnectorProbe,
  connectorId: string,
  /** A user's API-key grant for connectors that need one (KOBE-108); used for this probe only. */
  apiKey?: string,
): Promise<PinOutcome | undefined> {
  const [row] = await db
    .select({ name: connectors.name, url: connectors.url, hash: connectors.toolsHash })
    .from(connectors)
    .where(and(eq(connectors.id, connectorId), isNull(connectors.deletedAt)));
  if (!row) return undefined;
  if (row.hash !== null) return { ok: false, failure: "already_pinned" };

  const probed = await prober.probe(row.url, apiKey);
  if (!probed.ok) return probed;
  const snapshot = buildSnapshot(row.name, probed.tools);
  if (!snapshot.ok) return snapshot;

  return db.transaction(async (tx): Promise<PinOutcome> => {
    const written = await tx
      .update(connectors)
      .set({ toolsSnapshot: snapshot.tools, toolsHash: snapshot.hash, updatedAt: sql`now()` })
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
    await recordAudit(tx, {
      action: "mcp.connector.pinned",
      target: {
        connectorId,
        name: row.name,
        tools: snapshot.tools.length,
        hash: snapshot.hash,
      },
    });
    return { ok: true, tools: snapshot.tools.length };
  });
}
