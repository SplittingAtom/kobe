import { z } from "zod";
import { uuidSchema } from "./common.js";

/**
 * The Files panel keeping itself current (KOBE-599), additive.
 *
 * `POST /v1/workspace/sync` (Refresh = sync now): when the caller's sandbox is running, the server
 * asks it to push its local changes (sandbox wire `workspace.sync_now`) and answers once that push
 * has committed, or after at most {@link WORKSPACE_SYNC_WAIT_MS}; the panel lists afterwards.
 * `asleep`: no sandbox is running, so its last push is current (the server starts waking it, as
 * opening the panel does); `not_synced`: the sandbox could not push now (an older agent, still
 * restoring, sync off, the push failed); `timeout`: no answer in time. Every status is a 200: the
 * panel lists in every case.
 *
 * `GET /v1/workspace/events?team=` (SSE) tells an open panel to list again: `event:
 * workspace.state` once right after connecting, then `event: workspace.changed` whenever the
 * caller's own (team, user) workspace manifest gets a new revision (a sandbox push, an upload or
 * any server write, a project file reaching a mounted folder) or the workspace's projects or the
 * caller's checkouts change. `data` is one {@link workspaceEventSchema} JSON of opaque versions:
 * no paths, no names, nothing of another member. The owner comes from the session; `team` is
 * required because EventSource cannot send `X-Kobe-Team` (another active team answers 409
 * `team_mismatch`). Keep-alives and `retry:` as for run streams.
 */
export const WORKSPACE_SYNC_WAIT_MS = 10_000;

export const WORKSPACE_SYNC_STATUSES = ["synced", "asleep", "not_synced", "timeout"] as const;
export type WorkspaceSyncStatus = (typeof WORKSPACE_SYNC_STATUSES)[number];

export const workspaceSyncResponseSchema = z.strictObject({
  status: z.enum(WORKSPACE_SYNC_STATUSES),
});
export type WorkspaceSyncResponse = z.infer<typeof workspaceSyncResponseSchema>;

export const WORKSPACE_EVENT_TYPES = ["workspace.state", "workspace.changed"] as const;
export type WorkspaceEventType = (typeof WORKSPACE_EVENT_TYPES)[number];

export const workspaceEventSchema = z.strictObject({
  /** The manifest's head revision (0 before the first file). */
  files_rev: z.number().int().nonnegative(),
  /** An opaque version of the workspace's projects and the caller's checkouts. */
  projects_rev: z.string().min(1).max(64),
});
export type WorkspaceEvent = z.infer<typeof workspaceEventSchema>;

export const workspaceEventsQuerySchema = z.strictObject({ team: uuidSchema });
export type WorkspaceEventsQuery = z.infer<typeof workspaceEventsQuerySchema>;

/** One SSE message of the stream. `data` is always a single line. */
export function formatWorkspaceEvent(type: WorkspaceEventType, event: WorkspaceEvent): string {
  return `event: ${type}\ndata: ${JSON.stringify(event)}\n\n`;
}
