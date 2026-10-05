import type { ToolsOutcome } from "./client.js";
import { frameSizeProblem } from "./frame-size.js";
import {
  MAX_CONTENT_BYTES,
  MAX_TITLE_LENGTH,
  OP_ARTIFACT_PUT,
  TOOL_CREATE_ARTIFACT,
  TOOL_UPDATE_ARTIFACT,
  type ToolsRequest,
} from "./protocol.js";

/** What a tool needs of the channel (the real one is {@link ToolsClient}). */
export interface ToolsTransport {
  request(call: Omit<ToolsRequest, "id">): Promise<ToolsOutcome>;
}

export interface ToolResultLike {
  readonly content: { readonly type: "text"; readonly text: string }[];
  readonly details: Record<string, unknown>;
}

/** The slice of Pi's `ToolDefinition` kobe-tools uses (structural, so no Pi package dependency). */
export interface ToolDefinitionLike {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly promptSnippet: string;
  readonly promptGuidelines: string[];
  readonly parameters: Record<string, unknown>;
  execute(toolCallId: string, params: unknown): Promise<ToolResultLike>;
}

const KINDS = ["html", "svg", "markdown", "mermaid", "code", "csv"];
const CONTENT_SCHEMA = {
  type: "string",
  description: `The complete content, at most ${MAX_CONTENT_BYTES / 1024} KiB.`,
};
const TITLE_SCHEMA = { type: "string", minLength: 1, maxLength: MAX_TITLE_LENGTH };

const CREATE_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "title", "content"],
  properties: {
    kind: { type: "string", enum: KINDS, description: "What the content is." },
    title: { ...TITLE_SCHEMA, description: "A short title shown above the artifact." },
    content: CONTENT_SCHEMA,
    language: {
      type: "string",
      pattern: "^[a-z0-9][a-z0-9+#.-]{0,31}$",
      description: "Language of a code artifact, for example python. Only with kind code.",
    },
  },
};

const UPDATE_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  required: ["artifact_id", "content"],
  properties: {
    artifact_id: { type: "string", description: "The id create_artifact returned." },
    content: { ...CONTENT_SCHEMA, description: "The complete new content (not a diff)." },
    title: { ...TITLE_SCHEMA, description: "A new title; omit to keep the current one." },
  },
};

/** Raised for every failure; Pi turns a thrown error into an error tool result. */
export class ToolFailure extends Error {}

export function artifactTools(transport: ToolsTransport): ToolDefinitionLike[] {
  return [
    {
      name: TOOL_CREATE_ARTIFACT,
      label: "Create artifact",
      description:
        "Create an artifact: a document, page, diagram, table or code file the user sees next to the chat and can download. Returns artifact_id and version.",
      promptSnippet: "Show the user a document, web page, SVG, diagram, table or code file",
      promptGuidelines: [
        "Use create_artifact for output the user will keep or reuse; a code artifact is shown, not run.",
        "Use update_artifact with the artifact_id to change an artifact instead of creating a new one.",
      ],
      parameters: CREATE_PARAMETERS,
      execute: (toolCallId, params) => put(transport, toolCallId, TOOL_CREATE_ARTIFACT, params),
    },
    {
      name: TOOL_UPDATE_ARTIFACT,
      label: "Update artifact",
      description:
        "Replace the content of an artifact created earlier in this conversation. Returns artifact_id and the new version.",
      promptSnippet: "Change an artifact created earlier in this conversation",
      promptGuidelines: [],
      parameters: UPDATE_PARAMETERS,
      execute: (toolCallId, params) => put(transport, toolCallId, TOOL_UPDATE_ARTIFACT, params),
    },
  ];
}

async function put(
  transport: ToolsTransport,
  toolCallId: string,
  tool: string,
  params: unknown,
): Promise<ToolResultLike> {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw new ToolFailure("invalid input");
  }
  const input = params as Record<string, unknown>;
  const content = input.content;
  if (typeof content === "string" && Buffer.byteLength(content) > MAX_CONTENT_BYTES) {
    throw new ToolFailure(`content is larger than ${MAX_CONTENT_BYTES / 1024} KiB`);
  }
  const problem = frameSizeProblem(toolCallId, tool, input);
  if (problem !== undefined) throw new ToolFailure(problem);
  const outcome = await transport.request({
    op: OP_ARTIFACT_PUT,
    tool_call_id: toolCallId,
    tool,
    input,
  });
  if (!outcome.ok) throw new ToolFailure(`${outcome.error.code}: ${outcome.error.message}`);
  const result = { artifact_id: outcome.artifact_id, version: outcome.version };
  return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
}
