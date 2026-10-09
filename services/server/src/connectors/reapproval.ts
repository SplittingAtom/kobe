import { z } from "zod";
import {
  and,
  connectors,
  eq,
  isNull,
  parseToolsSnapshot,
  sql,
  type KobeDb,
  type PinnedTool,
} from "@kobe/db";
import { recordAudit } from "../audit/record.js";
import { approveTools, approvedHash } from "./drift.js";

/**
 * Install-admin review and re-approval of drifted tools (KOBE-102, D27). The review shows the
 * approved definition next to the live one; approving names each tool with the SHA-256 of the
 * definition the admin saw, so a tool that changed again meanwhile is refused (`stale`).
 */
export const approveSchema = z.strictObject({
  tools: z
    .array(
      z.strictObject({
        name: z.string().min(1).max(128),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
      }),
    )
    .min(1)
    .max(500),
});
export type ApproveInput = z.infer<typeof approveSchema>;

export interface ToolDefinition {
  readonly title?: string | undefined;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

export interface ToolReview {
  readonly name: string;
  readonly status: "pinned" | "drifted";
  /** `changed`: approved definition differs from the live one; `added`: new upstream. */
  readonly change: "changed" | "added" | null;
  /** The approved definition (absent for an added tool). */
  readonly approved?: ToolDefinition;
  /** The live definition awaiting approval, with the hash to send back when approving. */
  readonly live?: ToolDefinition & { readonly sha256: string };
}

const definition = (t: {
  title?: string | undefined;
  description: string;
  input_schema: Record<string, unknown>;
}): ToolDefinition => ({
  ...(t.title === undefined ? {} : { title: t.title }),
  description: t.description,
  inputSchema: t.input_schema,
});

export function reviewOf(tool: PinnedTool): ToolReview {
  if (tool.status === "pinned") {
    return { name: tool.name, status: "pinned", change: null, approved: definition(tool) };
  }
  if (tool.proposed) {
    return {
      name: tool.name,
      status: "drifted",
      change: "changed",
      approved: definition(tool),
      live: { ...definition(tool.proposed), sha256: tool.proposed.sha256 },
    };
  }
  return {
    name: tool.name,
    status: "drifted",
    change: "added",
    live: { ...definition(tool), sha256: tool.sha256 },
  };
}

export async function reviewConnectorTools(
  db: KobeDb,
  connectorId: string,
): Promise<ToolReview[] | undefined> {
  const [row] = await db
    .select({ snapshot: connectors.toolsSnapshot })
    .from(connectors)
    .where(and(eq(connectors.id, connectorId), isNull(connectors.deletedAt)));
  return row ? parseToolsSnapshot(row.snapshot).map(reviewOf) : undefined;
}

export type ApprovalOutcome =
  | { readonly ok: true; readonly approved: string[] }
  | { readonly ok: false; readonly error: "not_found" }
  | { readonly ok: false; readonly error: "not_pending" | "stale"; readonly tool: string };

export async function approveConnectorTools(
  db: KobeDb,
  connectorId: string,
  input: ApproveInput,
): Promise<ApprovalOutcome> {
  return db.transaction(async (tx): Promise<ApprovalOutcome> => {
    const [row] = await tx
      .select({ name: connectors.name, snapshot: connectors.toolsSnapshot })
      .from(connectors)
      .where(and(eq(connectors.id, connectorId), isNull(connectors.deletedAt)))
      .for("update");
    if (!row) return { ok: false, error: "not_found" };
    const result = approveTools(parseToolsSnapshot(row.snapshot), input.tools);
    if (!result.ok) return result;
    await tx
      .update(connectors)
      .set({
        toolsSnapshot: result.tools,
        toolsHash: approvedHash(result.tools),
        updatedAt: sql`now()`,
      })
      .where(eq(connectors.id, connectorId));
    await recordAudit(tx, {
      action: "mcp.connector.reapproved",
      target: { connectorId, name: row.name, tools: result.approved },
    });
    return { ok: true, approved: result.approved };
  });
}
