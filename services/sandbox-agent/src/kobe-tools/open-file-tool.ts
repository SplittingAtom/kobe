import { frameSizeProblem } from "./frame-size.js";
import { OP_FILE_OPEN, SHARE_PATH_MAX, TOOL_OPEN_FILE, type ToolsResponse } from "./protocol.js";
import {
  ToolFailure,
  type ToolDefinitionLike,
  type ToolResultLike,
  type ToolsTransport,
} from "./tools.js";

const PARAMETERS = {
  type: "object",
  additionalProperties: false,
  required: ["path"],
  properties: {
    path: {
      type: "string",
      minLength: 1,
      maxLength: SHARE_PATH_MAX,
      description: "The file to open: a path under /workspace (absolute, or relative to it).",
    },
  },
};

/**
 * `open_file` (KOBE-484): registered with `propose_file_edit` (the `file_edits` capability). The
 * user's web client opens the workspace file next to the conversation: text files in the editor,
 * images, PDFs, HTML and notebooks in their viewers. It reads and writes nothing.
 */
export function openFileTool(transport: ToolsTransport): ToolDefinitionLike {
  return {
    name: TOOL_OPEN_FILE,
    label: "Open file",
    description:
      "Open a file from /workspace for the user next to the conversation: text files (Markdown, CSV, JSON, code, ...) open in the editor, images, PDFs, HTML and notebooks in their viewers. Reads and writes nothing. Fails when the file does not exist.",
    promptSnippet: "Open a workspace file for the user to see or edit",
    promptGuidelines: [
      "When the user asks to open, show or view a workspace file, call open_file with its path, not share_file, create_artifact or the file's text pasted into your answer.",
      "If open_file says the file does not exist, tell the user; do not create it unless they asked for that.",
    ],
    parameters: PARAMETERS,
    execute: (toolCallId, params) => open(transport, toolCallId, params),
  };
}

const CONTROL = /[\u0000-\u001f\u007f]/u; // eslint-disable-line no-control-regex

function validInput(input: Record<string, unknown>): input is { path: string } {
  const { path } = input;
  return (
    Object.keys(input).every((key) => key === "path") &&
    typeof path === "string" &&
    path.length > 0 &&
    path.length <= SHARE_PATH_MAX &&
    !CONTROL.test(path) &&
    !path.split("/").includes("..")
  );
}

async function open(
  transport: ToolsTransport,
  toolCallId: string,
  params: unknown,
): Promise<ToolResultLike> {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw new ToolFailure("invalid input");
  }
  const input = params as Record<string, unknown>;
  if (!validInput(input)) {
    throw new ToolFailure("invalid input: expected { path } naming a file under /workspace");
  }
  const problem = frameSizeProblem(toolCallId, TOOL_OPEN_FILE, input);
  if (problem !== undefined) throw new ToolFailure(problem);
  const outcome = await transport.request({
    op: OP_FILE_OPEN,
    tool_call_id: toolCallId,
    tool: TOOL_OPEN_FILE,
    input,
  });
  if (!outcome.ok) throw new ToolFailure(`${outcome.error.code}: ${outcome.error.message}`);
  if (!("op" in outcome) || outcome.op !== "file_open") {
    throw new ToolFailure("unexpected answer to open_file");
  }
  const record = { status: "opened", path: outcome.path };
  return { content: [{ type: "text", text: JSON.stringify(record) }], details: { ...record } };
}

/** An `open_file` answer, or undefined when it is malformed (fail closed). */
export function parseFileOpenReply(value: Record<string, unknown>): ToolsResponse | undefined {
  const { path } = value;
  if (typeof path !== "string" || path === "") return undefined;
  return { id: value.id as string, ok: true, op: "file_open", path };
}
