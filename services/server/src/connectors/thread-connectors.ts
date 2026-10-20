import {
  and,
  connectors,
  eq,
  inArray,
  threadConnectorsOff,
  threads,
  isNull,
  type KobeTx,
} from "@kobe/db";
import { recordAudit } from "../audit/record.js";
import { exposedTools } from "../mcp/catalog.js";
import {
  loadTeamConnectorRows,
  loadUsableSiteKeys,
  loadUserGrantFacts,
  type GrantFact,
  type RunConnectorRow,
} from "../runs/run-mcp.js";

/**
 * The composer's Connectors (KOBE-451): the MCP servers a member can use in this team, as the run
 * decides them (team-enabled and active, something exposed, a usable credential: the member's own
 * live grant, or a usable site key, KOBE-303/449), each with whether this conversation has it on.
 * One that is not working says why, in fixed words (never a secret or an upstream detail), and
 * where it is fixed. The owner turns a working one off or on for one thread
 * (`thread_connectors_off`); the run start leaves an off one out of `run.start.mcp`.
 */

export const CONNECTOR_PROBLEMS = [
  "no_key",
  "not_connected",
  "grant_expired",
  "site_key_unusable",
  "refresh_auth_required",
  "tools_awaiting_approval",
] as const;
export type ConnectorProblem = (typeof CONNECTOR_PROBLEMS)[number];

const MY_KEYS = { href: "/me/connectors", label: "My connector keys" } as const;

/** What the member reads, and where it is fixed (null: a site admin fixes it). */
export const PROBLEM_TEXT: Readonly<
  Record<
    ConnectorProblem,
    { readonly message: string; readonly fix: { href: string; label: string } | null }
  >
> = {
  no_key: { message: "Add your API key for this server.", fix: MY_KEYS },
  not_connected: { message: "Connect your account to this server.", fix: MY_KEYS },
  grant_expired: { message: "Your sign-in to this server expired. Connect again.", fix: MY_KEYS },
  site_key_unusable: {
    message: "The site's key for this server can't be used. Ask a site admin.",
    fix: null,
  },
  refresh_auth_required: {
    message: "Kobe can't check this server for changes. Ask a site admin.",
    fix: null,
  },
  tools_awaiting_approval: {
    message: "Its tools changed and wait for a site admin's approval.",
    fix: null,
  },
};

export interface ChatConnector {
  readonly id: string;
  readonly name: string;
  /** On for this conversation (always true without one). */
  readonly enabled: boolean;
  /** Why it is not working; null when it works. */
  readonly problem: ConnectorProblem | null;
}

export interface ChatViewer {
  readonly teamId: string;
  readonly userId: string;
}

function credentialProblem(
  row: RunConnectorRow,
  grants: ReadonlyMap<string, GrantFact>,
  siteKeys: ReadonlySet<string>,
  now: Date,
): ConnectorProblem | null {
  if (row.authKind === "none") return null;
  if (row.credentialSource === "site") return siteKeys.has(row.id) ? null : "site_key_unusable";
  const grant = grants.get(row.id);
  if (grant === undefined || grant.kind !== row.authKind) {
    return row.authKind === "api_key" ? "no_key" : "not_connected";
  }
  if (grant.kind === "oauth" && grant.expiresAt !== null && grant.expiresAt <= now) {
    return "grant_expired";
  }
  return null;
}

/** The thread's off connectors (ids); the caller checks the thread is the viewer's. */
export async function connectorsOffIn(
  tx: KobeTx,
  teamId: string,
  threadId: string,
): Promise<Set<string>> {
  const rows = await tx
    .select({ id: threadConnectorsOff.connectorId })
    .from(threadConnectorsOff)
    .where(and(eq(threadConnectorsOff.teamId, teamId), eq(threadConnectorsOff.threadId, threadId)));
  return new Set(rows.map((r) => r.id));
}

/**
 * The member's connectors in this team, in name order, for `threadId` (null: a conversation not
 * started yet, everything on). A connector with nothing exposed and nothing awaiting approval is
 * not listed (the team shows the member nothing of it).
 */
export async function listChatConnectors(
  tx: KobeTx,
  viewer: ChatViewer,
  threadId: string | null,
  now = new Date(),
): Promise<ChatConnector[]> {
  const rows = await loadTeamConnectorRows(tx, viewer.teamId);
  if (rows.length === 0) return [];
  const grants = new Map(
    (await loadUserGrantFacts(tx, viewer.teamId, viewer.userId)).map((g) => [g.connectorId, g]),
  );
  const siteKeys = await loadUsableSiteKeys(tx, rows);
  const skipped = new Map(
    (
      await tx
        .select({ id: connectors.id, skipped: connectors.refreshSkipped })
        .from(connectors)
        .where(
          inArray(
            connectors.id,
            rows.map((r) => r.id),
          ),
        )
    ).map((r) => [r.id, r.skipped]),
  );
  const off =
    threadId === null ? new Set<string>() : await connectorsOffIn(tx, viewer.teamId, threadId);
  return rows
    .flatMap((row): ChatConnector[] => {
      const exposed = exposedTools(row).length > 0;
      const drifted = row.tools.some((t) => t.status === "drifted");
      if (!exposed && !drifted) return [];
      const problem =
        credentialProblem(row, grants, siteKeys, now) ??
        (skipped.get(row.id) === "auth_required" ? "refresh_auth_required" : null) ??
        (exposed ? null : "tools_awaiting_approval");
      return [{ id: row.id, name: row.name, enabled: !off.has(row.id), problem }];
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export type ToggleError = "thread_not_found" | "connector_not_found" | "connector_not_working";

/**
 * Turns `connectorId` on or off for the viewer's own thread, audited. Refused for a thread that is
 * not the viewer's (or in Trash), a connector the member is not offered here, and one that is not
 * working now: the server, not the client, decides what can be toggled.
 */
export async function setThreadConnector(
  tx: KobeTx,
  viewer: ChatViewer,
  threadId: string,
  connectorId: string,
  enabled: boolean,
): Promise<{ ok: true; connector: ChatConnector } | { ok: false; error: ToggleError }> {
  const [thread] = await tx
    .select({ id: threads.id })
    .from(threads)
    .where(
      and(
        eq(threads.teamId, viewer.teamId),
        eq(threads.id, threadId),
        eq(threads.ownerUserId, viewer.userId),
        eq(threads.isTest, false),
        isNull(threads.deletedAt),
      ),
    )
    .for("update");
  if (!thread) return { ok: false, error: "thread_not_found" };
  const listed = (await listChatConnectors(tx, viewer, threadId)).find((c) => c.id === connectorId);
  if (!listed) return { ok: false, error: "connector_not_found" };
  if (listed.problem !== null) return { ok: false, error: "connector_not_working" };
  if (listed.enabled !== enabled) {
    if (enabled) {
      await tx
        .delete(threadConnectorsOff)
        .where(
          and(
            eq(threadConnectorsOff.teamId, viewer.teamId),
            eq(threadConnectorsOff.threadId, threadId),
            eq(threadConnectorsOff.connectorId, connectorId),
          ),
        );
    } else {
      await tx.insert(threadConnectorsOff).values({
        teamId: viewer.teamId,
        threadId,
        connectorId,
        turnedOffBy: viewer.userId,
      });
    }
    await recordAudit(tx, {
      action: "thread.connector_toggled",
      teamId: viewer.teamId,
      target: { threadId, connectorId, enabled },
    });
  }
  return { ok: true, connector: { ...listed, enabled } };
}

/**
 * The connectors a new conversation starts with off (KOBE-451 review MEDIUM-3), checked before
 * the thread is created: each must be offered to the member and working, as for the toggle.
 * Null when they all are, else the refusal.
 */
export async function checkConnectorsOff(
  tx: KobeTx,
  viewer: ChatViewer,
  ids: readonly string[],
): Promise<"connector_not_found" | "connector_not_working" | null> {
  if (ids.length === 0) return null;
  const listed = new Map((await listChatConnectors(tx, viewer, null)).map((c) => [c.id, c]));
  for (const id of ids) {
    const c = listed.get(id);
    if (!c) return "connector_not_found";
    if (c.problem !== null) return "connector_not_working";
  }
  return null;
}

/** Writes a new thread's off connectors (checked by `checkConnectorsOff`), each audited. */
export async function turnOffAtCreation(
  tx: KobeTx,
  viewer: ChatViewer,
  threadId: string,
  ids: readonly string[],
): Promise<void> {
  for (const connectorId of ids) {
    await tx.insert(threadConnectorsOff).values({
      teamId: viewer.teamId,
      threadId,
      connectorId,
      turnedOffBy: viewer.userId,
    });
    await recordAudit(tx, {
      action: "thread.connector_toggled",
      teamId: viewer.teamId,
      target: { threadId, connectorId, enabled: false },
    });
  }
}
