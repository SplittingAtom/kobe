import {
  and,
  asc,
  connectors,
  eq,
  isNull,
  parseToolsSnapshot,
  teamConnectors,
  withTeam,
  type ConnectorExposureKind,
  type KobeDb,
} from "@kobe/db";
import { recordAudit } from "../audit/record.js";

/**
 * Team connector enablement (spec D27, KOBE-104). Connectors are off by default: no
 * `team_connectors` row = not enabled. A team admin enables an install connector with an
 * exposure (`read_only`: tools with readOnlyHint; `all`; `custom`: a tick list of Pi tool names).
 * The MCP proxy and the run offering read these rows (KOBE-106 enforces them at the proxy).
 */
export interface TeamConnectorToolView {
  readonly pi_name: string;
  readonly name: string;
  readonly title: string | null;
  readonly read_only: boolean;
  readonly status: "pinned" | "drifted";
}

export interface TeamConnectorView {
  readonly id: string;
  readonly name: string;
  readonly auth_kind: "oauth" | "api_key" | "none";
  readonly status: "active" | "disabled";
  readonly icon_url: string | null;
  readonly enabled: boolean;
  readonly exposure: ConnectorExposureKind | null;
  readonly enabled_tools: readonly string[];
  readonly tools: readonly TeamConnectorToolView[];
}

type Row = typeof connectors.$inferSelect;
type Enablement = Pick<typeof teamConnectors.$inferSelect, "exposure" | "enabledTools">;

function view(row: Row, e: Enablement | undefined): TeamConnectorView {
  return {
    id: row.id,
    name: row.name,
    auth_kind: row.authKind,
    status: row.status,
    icon_url: row.iconUrl,
    enabled: e !== undefined,
    exposure: e?.exposure ?? null,
    enabled_tools: e?.enabledTools ?? [],
    tools: parseToolsSnapshot(row.toolsSnapshot).map((t) => ({
      pi_name: t.pi_name,
      name: t.name,
      title: t.title ?? t.annotations.title ?? null,
      read_only: t.annotations.readOnlyHint === true,
      status: t.status,
    })),
  };
}

/** Registered (not removed) connectors with this team's enablement. */
export async function listTeamConnectors(db: KobeDb, teamId: string): Promise<TeamConnectorView[]> {
  return withTeam(db, teamId, async (tx) => {
    const [rows, enabled] = await Promise.all([
      tx.select().from(connectors).where(isNull(connectors.deletedAt)).orderBy(asc(connectors.name)),
      tx.select().from(teamConnectors).where(eq(teamConnectors.teamId, teamId)),
    ]);
    const byId = new Map(enabled.map((e) => [e.connectorId, e]));
    return rows.map((r) => view(r, byId.get(r.id)));
  });
}

export interface ExposureInput {
  readonly exposure: ConnectorExposureKind;
  readonly enabledTools: readonly string[];
}

export type SetTeamConnectorResult =
  | { readonly ok: true; readonly connector: TeamConnectorView }
  | { readonly ok: false; readonly error: "not_found" | "connector_disabled" | "unknown_tool" };

const same = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/** Enables the connector for the team or changes its exposure; audits only real changes. */
export async function setTeamConnector(
  db: KobeDb,
  teamId: string,
  connectorId: string,
  input: ExposureInput,
  userId: string,
): Promise<SetTeamConnectorResult> {
  return withTeam(db, teamId, async (tx) => {
    // FOR SHARE: the install admin's soft delete / disable waits until this commits.
    const [row] = await tx
      .select()
      .from(connectors)
      .where(and(eq(connectors.id, connectorId), isNull(connectors.deletedAt)))
      .for("share");
    if (!row) return { ok: false, error: "not_found" } as const;
    if (row.status !== "active") return { ok: false, error: "connector_disabled" } as const;
    const pinned = new Set(
      parseToolsSnapshot(row.toolsSnapshot)
        .filter((t) => t.status === "pinned")
        .map((t) => t.pi_name),
    );
    const tools = input.exposure === "custom" ? [...new Set(input.enabledTools)].toSorted() : [];
    if (!tools.every((t) => pinned.has(t))) return { ok: false, error: "unknown_tool" } as const;
    const [before] = await tx
      .select()
      .from(teamConnectors)
      .where(and(eq(teamConnectors.teamId, teamId), eq(teamConnectors.connectorId, connectorId)))
      .for("update");
    const next: Enablement = { exposure: input.exposure, enabledTools: tools };
    if (!before || before.exposure !== next.exposure || !same(before.enabledTools, tools)) {
      await tx
        .insert(teamConnectors)
        .values({ teamId, connectorId, ...next, enabledBy: userId })
        .onConflictDoUpdate({
          target: [teamConnectors.teamId, teamConnectors.connectorId],
          set: next,
        });
      await recordAudit(tx, {
        action: "team.connector.changed",
        teamId,
        target: {
          connectorId,
          name: row.name,
          change: before ? "exposure_changed" : "enabled",
          exposure: next.exposure,
          tools,
        },
      });
    }
    return { ok: true, connector: view(row, next) } as const;
  });
}

/** Disables the connector for the team; false when it was not enabled. */
export async function disableTeamConnector(
  db: KobeDb,
  teamId: string,
  connectorId: string,
): Promise<boolean> {
  return withTeam(db, teamId, async (tx) => {
    const gone = await tx
      .delete(teamConnectors)
      .where(and(eq(teamConnectors.teamId, teamId), eq(teamConnectors.connectorId, connectorId)))
      .returning({ id: teamConnectors.connectorId });
    if (gone.length === 0) return false;
    const [row] = await tx
      .select({ name: connectors.name })
      .from(connectors)
      .where(eq(connectors.id, connectorId));
    await recordAudit(tx, {
      action: "team.connector.changed",
      teamId,
      target: { connectorId, name: row?.name ?? "", change: "disabled" },
    });
    return true;
  });
}
