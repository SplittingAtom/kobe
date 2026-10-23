import { defineDomain } from "./types.js";

/** Sandbox Runtime (KOBE-21–28). */
export const sandbox = defineDomain({
  // Wire connection registry, in-flight commands and run leases (KOBE-24); lifecycle (KOBE-25).
  // Workspace sync (KOBE-27): manifest, uploaded blobs, per-workspace revision and totals.
  team: [
    "sandbox_connections",
    "sandbox_commands",
    "sandbox_run_leases",
    // An eval thread's ephemeral sandbox connection (KOBE-325).
    "sandbox_eval_connections",
    "sandboxes",
    "workspace_sync",
    "workspace_files",
    "workspace_blobs",
    // A legal hold's copy of moved files' old paths (KOBE-304).
    "workspace_file_hold_history",
    // The move journal the sandbox replays as local renames (KOBE-304).
    "workspace_moves",
    // Sync conflicts reported by the sandbox (KOBE-492).
    "workspace_sync_conflicts",
  ],
  siteWide: [],
  grants: {},
  teamReferencing: {},
});
