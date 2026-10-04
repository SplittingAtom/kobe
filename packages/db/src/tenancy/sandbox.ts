import { defineDomain } from "./types.js";

/** Sandbox Runtime (KOBE-21–28). */
export const sandbox = defineDomain({
  // Wire connection registry, in-flight commands and run leases (KOBE-24); lifecycle (KOBE-25).
  // Workspace sync (KOBE-27): manifest, uploaded blobs, per-workspace revision and totals.
  team: [
    "sandbox_connections",
    "sandbox_commands",
    "sandbox_run_leases",
    "sandboxes",
    "workspace_sync",
    "workspace_files",
    "workspace_blobs",
  ],
  installWide: [],
  grants: {},
  teamReferencing: {},
});
