import { frameSizeProblem } from "./frame-size.js";
import {
  FILE_EDIT_CONTENT_MAX_BYTES,
  FILE_EDIT_SUMMARY_MAX,
  OP_FILE_EDIT_PROPOSE,
  SHARE_PATH_MAX,
  TOOL_PROPOSE_FILE_EDIT,
  type ToolsResponse,
} from "./protocol.js";
import {
  ToolFailure,
  type ToolDefinitionLike,
  type ToolResultLike,
  type ToolsTransport,
} from "./tools.js";

const KEYS = new Set(["path", "content", "summary"]);

const PARAMETERS = {
  type: "object",
  additionalProperties: false,
  required: ["path", "content", "summary"],
  properties: {
    path: {
      type: "string",
      minLength: 1,
      maxLength: SHARE_PATH_MAX,
      description: "The file to change: a path under /workspace (absolute, or relative to it).",
    },
    content: {
      type: "string",
      description: `The file's whole new content (not a patch), at most ${FILE_EDIT_CONTENT_MAX_BYTES} bytes.`,
    },
    summary: {
      type: "string",
      minLength: 1,
      maxLength: FILE_EDIT_SUMMARY_MAX,
      description: "One line for the user reviewing the change: what it does.",
    },
  },
};

const NEXT =
  "Nothing was written: the user sees your proposal as a diff, accepts or rejects each change and commits it. Do not change the file yourself; tell the user what you proposed.";

/**
 * `propose_file_edit` (KOBE-462): registered only for an agent that announced `file_edits`. The
 * model proposes a whole new content for a workspace file; the server records it for the user's
 * review and writes nothing. The user commits accepted changes in the web.
 */
export function proposeFileEditTool(transport: ToolsTransport): ToolDefinitionLike {
  return {
    name: TOOL_PROPOSE_FILE_EDIT,
    label: "Propose file edit",
    description:
      "Propose a new content for a file in /workspace for the user to review as a diff. It writes nothing: the user accepts or rejects each change and commits. Returns the proposal, awaiting the user.",
    promptSnippet: "Propose changes to a workspace file for the user to review and commit",
    promptGuidelines: [
      "When the user has a workspace file open (the viewed-file section) and asks you to change it, use propose_file_edit with the whole new content instead of editing that file with write, edit or bash; the user reviews and commits the change.",
      "Propose one file per call, based on its current content; after the user commits, propose further changes against the new content.",
    ],
    parameters: PARAMETERS,
    execute: (toolCallId, params) => propose(transport, toolCallId, params),
  };
}

const CONTROL = /[\u0000-\u001f\u007f]/u; // eslint-disable-line no-control-regex

function validInput(input: Record<string, unknown>): boolean {
  const { path, content, summary } = input;
  return (
    Object.keys(input).every((key) => KEYS.has(key)) &&
    typeof path === "string" &&
    path.length > 0 &&
    path.length <= SHARE_PATH_MAX &&
    !CONTROL.test(path) &&
    !path.split("/").includes("..") &&
    typeof content === "string" &&
    !content.includes("\u0000") &&
    Buffer.byteLength(content) <= FILE_EDIT_CONTENT_MAX_BYTES &&
    typeof summary === "string" &&
    summary.length > 0 &&
    summary.length <= FILE_EDIT_SUMMARY_MAX
  );
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
  if (!validInput(input)) {
    throw new ToolFailure(
      `invalid input: expected { path, content, summary } (content at most ${FILE_EDIT_CONTENT_MAX_BYTES} bytes, no NUL)`,
    );
  }
  const problem = frameSizeProblem(toolCallId, TOOL_PROPOSE_FILE_EDIT, input);
  if (problem !== undefined) throw new ToolFailure(problem);
  const outcome = await transport.request({
    op: OP_FILE_EDIT_PROPOSE,
    tool_call_id: toolCallId,
    tool: TOOL_PROPOSE_FILE_EDIT,
    input,
  });
  if (!outcome.ok) throw new ToolFailure(`${outcome.error.code}: ${outcome.error.message}`);
  if (!("op" in outcome) || outcome.op !== "file_edit_propose") {
    throw new ToolFailure("unexpected answer to propose_file_edit");
  }
  const record = { status: outcome.status, path: outcome.path, base_sha256: outcome.base_sha256 };
  return {
    content: [{ type: "text", text: JSON.stringify({ ...record, next: NEXT }) }],
    details: { ...record },
  };
}

const HEX64 = /^[0-9a-f]{64}$/;

/** A `propose_file_edit` answer, or undefined when it is malformed (fail closed). */
export function parseFileEditReply(value: Record<string, unknown>): ToolsResponse | undefined {
  const { status, path, base_sha256: base } = value;
  if (status !== "awaiting_user" || typeof path !== "string" || path === "") return undefined;
  if (typeof base !== "string" || !HEX64.test(base)) return undefined;
  return {
    id: value.id as string,
    ok: true,
    op: "file_edit_propose",
    status,
    path,
    base_sha256: base,
  };
}
