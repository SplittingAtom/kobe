import { frameSizeProblem } from "./frame-size.js";
import {
  OP_PROJECT_FILE_PROPOSE,
  PROJECT_PROPOSE_REASON_MAX,
  SHARE_NAME_MAX,
  SHARE_PATH_MAX,
  TOOL_PROPOSE_PROJECT_FILE,
} from "./protocol.js";
import {
  ToolFailure,
  type ToolDefinitionLike,
  type ToolResultLike,
  type ToolsTransport,
} from "./tools.js";

const PROPOSE_KEYS = new Set(["path", "name", "folder", "reason"]);

const PROPOSE_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  required: ["path"],
  properties: {
    path: {
      type: "string",
      minLength: 1,
      maxLength: SHARE_PATH_MAX,
      description:
        "The file to propose: a path under /workspace (absolute, or relative to /workspace).",
    },
    name: {
      type: "string",
      minLength: 1,
      maxLength: SHARE_NAME_MAX,
      description: "The file's name in the project; default: the file's own name.",
    },
    folder: {
      type: "string",
      maxLength: SHARE_PATH_MAX,
      description: "The folder in the project (for example docs/specs); default: the project root.",
    },
    reason: {
      type: "string",
      minLength: 1,
      maxLength: PROJECT_PROPOSE_REASON_MAX,
      description: "One line for the person who approves: why this file belongs in the project.",
    },
  },
};

/**
 * `propose_project_file` (KOBE-162): registered only for an agent that announced the `projects`
 * capability. It never adds anything by itself: the project's members see an approval card, and
 * only an approved proposal copies the (already saved) file into the project's files.
 */
export function proposeProjectFileTool(transport: ToolsTransport): ToolDefinitionLike {
  return {
    name: TOOL_PROPOSE_PROJECT_FILE,
    label: "Propose project file",
    description:
      "Propose adding a file from /workspace to the project's shared files (read-only for every project member, under /workspace/projects). A person must approve it first. Returns the proposal, pending until approved.",
    promptSnippet: "Propose a workspace file for the current project's shared files",
    promptGuidelines: [
      "Use propose_project_file for a finished file the whole project should keep (a spec, a dataset); files under /workspace/projects are the project's and cannot be edited, copy one elsewhere to change it.",
    ],
    parameters: PROPOSE_PARAMETERS,
    execute: (toolCallId, params) => propose(transport, toolCallId, params),
  };
}

function stringWithin(value: unknown, max: number, min: number): boolean {
  return typeof value === "string" && value.length >= min && value.length <= max;
}

async function propose(
  transport: ToolsTransport,
  toolCallId: string,
  params: unknown,
): Promise<ToolResultLike> {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw new ToolFailure("invalid input");
  }
  const input = params as Record<string, unknown>;
  const optional = (key: string, max: number, min: number) =>
    input[key] === undefined || stringWithin(input[key], max, min);
  if (
    Object.keys(input).some((key) => !PROPOSE_KEYS.has(key)) ||
    !stringWithin(input.path, SHARE_PATH_MAX, 1) ||
    !optional("name", SHARE_NAME_MAX, 1) ||
    !optional("folder", SHARE_PATH_MAX, 0) ||
    !optional("reason", PROJECT_PROPOSE_REASON_MAX, 1)
  ) {
    throw new ToolFailure("invalid input: expected { path, name?, folder?, reason? }");
  }
  const problem = frameSizeProblem(toolCallId, TOOL_PROPOSE_PROJECT_FILE, input);
  if (problem !== undefined) throw new ToolFailure(problem);
  const outcome = await transport.request({
    op: OP_PROJECT_FILE_PROPOSE,
    tool_call_id: toolCallId,
    tool: TOOL_PROPOSE_PROJECT_FILE,
    input,
  });
  if (!outcome.ok) throw new ToolFailure(`${outcome.error.code}: ${outcome.error.message}`);
  if (!("proposal_id" in outcome))
    throw new ToolFailure("unexpected answer to propose_project_file");
  const { ok: _ok, ...record } = outcome;
  return { content: [{ type: "text", text: JSON.stringify(record) }], details: { ...record } };
}
