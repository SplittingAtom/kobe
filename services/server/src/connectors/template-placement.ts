import { z } from "zod";
import {
  and,
  connectorUiResources,
  connectors,
  eq,
  isNull,
  sql,
  UI_RESOURCE_PLACEMENTS,
  type KobeDb,
  type UiResourcePlacement,
} from "@kobe/db";
import { recordAudit } from "../audit/record.js";

/**
 * Where each pinned template's app opens (KOBE-531, spec MA3 as amended 2026-10-31): a site
 * admin's choice per template, `chat` (the card), `artifacts` (the card's stub, the frame in the
 * artifact column) or `rail` (also in the rail's Pickers). Not part of the pin hash, so drift and
 * re-approval leave it alone; never sent to the model.
 */
export const setPlacementSchema = z.strictObject({
  uri: z.string().min(1).max(2048),
  placement: z.enum(UI_RESOURCE_PLACEMENTS),
});
export type SetPlacementInput = z.infer<typeof setPlacementSchema>;

export type SetPlacementOutcome =
  | { readonly ok: true; readonly uri: string; readonly placement: UiResourcePlacement }
  | { readonly ok: false; readonly error: "not_found" | "template_not_found" };

/** Each template's placement of a connector, by URI. */
export async function templatePlacements(
  db: KobeDb,
  connectorId: string,
): Promise<ReadonlyMap<string, UiResourcePlacement>> {
  const rows = await db
    .select({ uri: connectorUiResources.uri, placement: connectorUiResources.placement })
    .from(connectorUiResources)
    .where(eq(connectorUiResources.connectorId, connectorId));
  return new Map(rows.map((r) => [r.uri, r.placement]));
}

/** Sets one template's placement; audited (site event) only when it changes. */
export async function setTemplatePlacement(
  db: KobeDb,
  connectorId: string,
  input: SetPlacementInput,
): Promise<SetPlacementOutcome> {
  return db.transaction(async (tx): Promise<SetPlacementOutcome> => {
    const [connector] = await tx
      .select({ name: connectors.name })
      .from(connectors)
      .where(and(eq(connectors.id, connectorId), isNull(connectors.deletedAt)))
      .for("update");
    if (!connector) return { ok: false, error: "not_found" };
    const where = and(
      eq(connectorUiResources.connectorId, connectorId),
      eq(connectorUiResources.uri, input.uri),
    );
    const [row] = await tx
      .select({ placement: connectorUiResources.placement })
      .from(connectorUiResources)
      .where(where)
      .for("update");
    if (!row) return { ok: false, error: "template_not_found" };
    if (row.placement !== input.placement) {
      await tx
        .update(connectorUiResources)
        .set({ placement: input.placement, updatedAt: sql`now()` })
        .where(where);
      await recordAudit(tx, {
        action: "mcp.connector.template_placement_set",
        target: {
          connectorId,
          name: connector.name,
          uri: input.uri,
          previous: row.placement,
          placement: input.placement,
        },
      });
    }
    return { ok: true, uri: input.uri, placement: input.placement };
  });
}
