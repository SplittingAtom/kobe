import type { ToolsResponse } from "./protocol.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A `propose_project_file` answer (projects.ts), or undefined when it is malformed (fail closed). */
export function parseProjectReply(value: Record<string, unknown>): ToolsResponse | undefined {
  const { status, proposal_id: proposal, project_id: project, path, file } = value;
  if (status !== "applied" && status !== "pending_approval") return undefined;
  if (typeof proposal !== "string" || typeof project !== "string" || typeof path !== "string") {
    return undefined;
  }
  if (file !== undefined && !isRecord(file)) return undefined;
  return {
    id: value.id as string,
    ok: true,
    op: "project_file_propose",
    status,
    proposal_id: proposal,
    project_id: project,
    path,
    ...(file === undefined ? {} : { file }),
  };
}
