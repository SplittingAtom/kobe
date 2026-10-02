import { defineDomain } from "./types.js";

/** Sandbox Runtime (KOBE-21–28). */
export const sandbox = defineDomain({
  // Wire connection registry, in-flight commands and run leases (KOBE-24).
  team: ["sandbox_connections", "sandbox_commands", "sandbox_run_leases"],
  installWide: [],
  grants: {},
  teamReferencing: {},
});
