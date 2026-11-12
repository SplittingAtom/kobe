import { z } from "zod";

/**
 * The built-in Kobe MCP connector (KOBE-618/619, spec kobe-admin-mcp §3): its fixed id, the same on
 * every site (`@kobe/db` `KOBE_BUILTIN_CONNECTOR_ID`, check-enforced on the row). The MCP proxy
 * routes `POST /v1/mcp/<this id>` to the server's internal listener (`/internal/v1/mcp/kobe/*`)
 * instead of an upstream server; nothing about it reaches a sandbox but the id.
 */
export const KOBE_BUILTIN_CONNECTOR_ID = "6b6f6265-0000-4000-8000-000000000001";

/** The page shown in place of a Kobe admin tool's output to a viewer without its permission (KA6). */
export const KOBE_ADMIN_RESULT_HIDDEN = "Admin result hidden";

/** Longest server-built summary line of a Kobe admin change (names resolved, KOBE-623). */
export const KOBE_ADMIN_SUMMARY_MAX = 1_000;

/**
 * What an approval card shows for a Kobe admin write (KOBE-623, spec kobe-admin-mcp §6 "The card"):
 * the scope (`Team Research`, or `Whole site`) and a summary line the server built from the input
 * (names resolved from ids), never from model text. The card still shows the exact input below
 * it; such an approval is never remembered and never part of "Approve all waiting".
 */
export const kobeAdminApprovalSchema = z.strictObject({
  scope: z.enum(["team", "site"]),
  scope_label: z.string().min(1).max(200),
  summary: z.string().min(1).max(KOBE_ADMIN_SUMMARY_MAX),
});
export type KobeAdminApproval = z.infer<typeof kobeAdminApprovalSchema>;
