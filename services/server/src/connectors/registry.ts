import { z } from "zod";
import {
  CONNECTOR_NAME_PATTERN,
  CONNECTOR_URL_MAX,
  and,
  asc,
  connectors,
  eq,
  isNull,
  sql,
  teams,
  withTeam,
  teamConnectors,
  type KobeDb,
  type KobeTx,
} from "@kobe/db";
import { recordAudit } from "../audit/record.js";
import { dropConnectorGrants } from "./grants.js";

/**
 * The install connector registry (KOBE-100, spec D6, D27): MCP servers an install admin registers.
 * This module owns the rows; probing and pinning tools (KOBE-101), team enablement (KOBE-104) and
 * credentials (KOBE-107/108) come later. Audit records ids, names and changed field names only:
 * a URL can carry a key in its query string, so it never leaves the table.
 */

export const AUTH_KINDS = ["none", "api_key", "oauth"] as const;
export const STATUSES = ["active", "disabled"] as const;

const nameSchema = z
  .string()
  .max(64)
  .regex(new RegExp(CONNECTOR_NAME_PATTERN), "lowercase letters and digits joined by - or _");
const urlSchema = z.string().trim().min(1).max(CONNECTOR_URL_MAX);
/** https only, no credentials: the browser loads it as an image for every admin. */
const iconSchema = z
  .string()
  .trim()
  .max(CONNECTOR_URL_MAX)
  .refine((v) => {
    try {
      const u = new URL(v);
      return u.protocol === "https:" && u.username === "" && u.password === "" && u.hash === "";
    } catch {
      return false;
    }
  }, "an https URL");

export const createSchema = z.strictObject({
  name: nameSchema,
  url: urlSchema,
  iconUrl: iconSchema.nullish(),
  authKind: z.enum(AUTH_KINDS).default("none"),
});

export const updateSchema = z
  .strictObject({
    name: nameSchema,
    url: urlSchema,
    iconUrl: iconSchema.nullable(),
    authKind: z.enum(AUTH_KINDS),
    status: z.enum(STATUSES),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, "nothing to change");

export type CreateInput = z.infer<typeof createSchema>;
export type UpdateInput = z.infer<typeof updateSchema>;
export type ChangedField = "name" | "url" | "iconUrl" | "authKind" | "status";

export interface ConnectorView {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly iconUrl: string | null;
  readonly authKind: (typeof AUTH_KINDS)[number];
  readonly status: (typeof STATUSES)[number];
  readonly toolCount: number;
  /** Tools disabled pending re-approval (KOBE-102). */
  readonly driftedCount: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

const columns = {
  id: connectors.id,
  name: connectors.name,
  url: connectors.url,
  iconUrl: connectors.iconUrl,
  authKind: connectors.authKind,
  status: connectors.status,
  toolCount: sql<number>`jsonb_array_length(${connectors.toolsSnapshot})`.mapWith(Number),
  driftedCount:
    sql<number>`(SELECT count(*) FROM jsonb_array_elements(${connectors.toolsSnapshot}) AS t WHERE t->>'status' = 'drifted')`.mapWith(
      Number,
    ),
  createdAt: connectors.createdAt,
  updatedAt: connectors.updatedAt,
} as const;

const live = isNull(connectors.deletedAt);

export async function listConnectors(db: KobeDb): Promise<ConnectorView[]> {
  return db.select(columns).from(connectors).where(live).orderBy(asc(connectors.name));
}

export async function getConnector(db: KobeDb, id: string): Promise<ConnectorView | undefined> {
  const [row] = await db
    .select(columns)
    .from(connectors)
    .where(and(eq(connectors.id, id), live));
  return row;
}

export type NameConflict = "name_taken" | "name_removed";

/** The conflicting row's state, for a precise message (a removed connector still holds its name). */
async function nameConflict(
  tx: KobeTx,
  name: string,
  exceptId?: string,
): Promise<NameConflict | undefined> {
  const rows = await tx
    .select({ id: connectors.id, deletedAt: connectors.deletedAt })
    .from(connectors)
    .where(sql`replace(${connectors.name}, '-', '_') = replace(${name}, '-', '_')`);
  const other = rows.find((r) => r.id !== exceptId);
  if (!other) return undefined;
  return other.deletedAt ? "name_removed" : "name_taken";
}

export async function createConnector(
  db: KobeDb,
  input: CreateInput & { readonly url: string },
  userId: string,
): Promise<{ ok: true; connector: ConnectorView } | { ok: false; error: NameConflict }> {
  return db.transaction(async (tx) => {
    const conflict = await nameConflict(tx, input.name);
    if (conflict) return { ok: false as const, error: conflict };
    const [row] = await tx
      .insert(connectors)
      .values({
        name: input.name,
        url: input.url,
        iconUrl: input.iconUrl ?? null,
        authKind: input.authKind,
        createdBy: userId,
      })
      .returning(columns);
    if (!row) throw new Error("connector insert returned no row");
    await recordAudit(tx, {
      action: "mcp.connector.registered",
      target: { connectorId: row.id, name: row.name, authKind: row.authKind },
    });
    return { ok: true as const, connector: row };
  });
}

export async function updateConnector(
  db: KobeDb,
  id: string,
  input: UpdateInput,
): Promise<
  { ok: true; connector: ConnectorView } | { ok: false; error: NameConflict | "not_found" }
> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(connectors)
      .where(and(eq(connectors.id, id), live))
      .for("update");
    if (!current) return { ok: false as const, error: "not_found" as const };
    if (input.name !== undefined && input.name !== current.name) {
      const conflict = await nameConflict(tx, input.name, id);
      if (conflict) return { ok: false as const, error: conflict };
    }
    const changed: ChangedField[] = [];
    const set: Partial<typeof connectors.$inferInsert> = {};
    if (input.name !== undefined && input.name !== current.name) {
      set.name = input.name;
      changed.push("name");
    }
    if (input.url !== undefined && input.url !== current.url) {
      set.url = input.url;
      // A different server: its tools were never reviewed, so the old pins must not carry over.
      set.toolsSnapshot = [];
      set.toolsHash = null;
      changed.push("url");
      // Credentials were issued for the old server: drop them (users reconnect), same transaction.
      await dropConnectorGrants(tx, id, current.name);
    }
    if (input.iconUrl !== undefined && input.iconUrl !== current.iconUrl) {
      set.iconUrl = input.iconUrl;
      changed.push("iconUrl");
    }
    if (input.authKind !== undefined && input.authKind !== current.authKind) {
      set.authKind = input.authKind;
      changed.push("authKind");
    }
    if (input.status !== undefined && input.status !== current.status) {
      set.status = input.status;
      changed.push("status");
    }
    if (changed.length === 0) return { ok: true as const, connector: await view(tx, id) };
    await tx
      .update(connectors)
      .set({ ...set, updatedAt: sql`now()` })
      .where(eq(connectors.id, id));
    await recordAudit(tx, {
      action: "mcp.connector.updated",
      target: { connectorId: id, name: set.name ?? current.name, changed },
    });
    return { ok: true as const, connector: await view(tx, id) };
  });
}

async function view(tx: KobeTx, id: string): Promise<ConnectorView> {
  const [row] = await tx.select(columns).from(connectors).where(eq(connectors.id, id));
  if (!row) throw new Error("connector vanished inside its transaction");
  return row;
}

/**
 * How many teams have the connector enabled. `team_connectors` is a team table, so the count walks
 * the teams (an install has few) one `withTeam` at a time; RLS never lets one query see them all.
 */
export async function countTeamsUsing(db: KobeDb, connectorId: string): Promise<number> {
  const all = await db.select({ id: teams.id }).from(teams);
  let used = 0;
  for (const team of all) {
    const rows = await withTeam(db, team.id, (tx) =>
      tx
        .select({ one: sql<number>`1` })
        .from(teamConnectors)
        .where(eq(teamConnectors.connectorId, connectorId))
        .limit(1),
    );
    if (rows.length > 0) used += 1;
  }
  return used;
}

export interface RemovalResult {
  readonly removed: true;
  /** Always true: the API never hard-deletes (a hard delete would cascade into team rows). */
  readonly soft: true;
  /** Teams that had it enabled when it was removed (informational; may lag a concurrent enable). */
  readonly teams: number;
}

/**
 * Removes a connector from the registry by soft delete only: `status=disabled` + `deleted_at`. A
 * hard delete would cascade into `team_connectors`, and a team enabling the connector concurrently
 * (KOBE-104) could lose its row. The row is locked, so concurrent removals serialize.
 */
export async function removeConnector(db: KobeDb, id: string): Promise<RemovalResult | undefined> {
  const usedBy = await countTeamsUsing(db, id);
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ name: connectors.name })
      .from(connectors)
      .where(and(eq(connectors.id, id), live))
      .for("update");
    if (!row) return undefined;
    await tx
      .update(connectors)
      .set({ status: "disabled", deletedAt: sql`now()`, updatedAt: sql`now()` })
      .where(eq(connectors.id, id));
    await recordAudit(tx, {
      action: "mcp.connector.removed",
      target: { connectorId: id, name: row.name, soft: true, teams: usedBy },
    });
    return { removed: true as const, soft: true as const, teams: usedBy };
  });
}
