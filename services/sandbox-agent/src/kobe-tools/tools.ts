import type { ToolsOutcome } from "./client.js";
import { frameSizeProblem } from "./frame-size.js";
import {
  MAX_CONTENT_BYTES,
  MAX_TITLE_LENGTH,
  OP_ARTIFACT_PUT,
  OP_FILE_SHARE,
  OP_WEB_SEARCH,
  SHARE_DESCRIPTION_MAX,
  SHARE_NAME_MAX,
  SHARE_PATH_MAX,
  TOOL_CREATE_ARTIFACT,
  TOOL_SHARE_FILE,
  TOOL_UPDATE_ARTIFACT,
  TOOL_WEB_SEARCH,
  WEB_SEARCH_COUNT_MAX,
  WEB_SEARCH_QUERY_MAX,
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

const SHARE_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  required: ["path"],
  properties: {
    path: {
      type: "string",
      minLength: 1,
      maxLength: SHARE_PATH_MAX,
      description:
        "The file to share: a path under /workspace (absolute, or relative to /workspace).",
    },
    name: {
      type: "string",
      minLength: 1,
      maxLength: SHARE_NAME_MAX,
      description: "The name the user sees when downloading; default: the file's own name.",
    },
    description: {
      type: "string",
      minLength: 1,
      maxLength: SHARE_DESCRIPTION_MAX,
      description: "One line about what the file is.",
    },
  },
};
const SHARE_KEYS = new Set(["path", "name", "description"]);

/** `share_file` (KOBE-149): registered only for an agent that announced the `files` capability. */
export function shareFileTool(transport: ToolsTransport): ToolDefinitionLike {
  return {
    name: TOOL_SHARE_FILE,
    label: "Share file",
    description:
      "Share a file from /workspace with the user as a download card. The file is saved first, so later edits do not change what the user gets. Returns the file record.",
    promptSnippet: "Give the user a file from the workspace to download",
    promptGuidelines: [
      "Use share_file for a finished file the user asked for or will keep (a report, a spreadsheet, an archive); anything in /workspace can be shared, but not files over 100 MiB.",
    ],
    parameters: SHARE_PARAMETERS,
    execute: (toolCallId, params) => share(transport, toolCallId, params),
  };
}

function stringWithin(value: unknown, max: number, required: boolean): boolean {
  if (value === undefined) return !required;
  return typeof value === "string" && value.length >= 1 && value.length <= max;
}

async function share(
  transport: ToolsTransport,
  toolCallId: string,
  params: unknown,
): Promise<ToolResultLike> {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw new ToolFailure("invalid input");
  }
  const input = params as Record<string, unknown>;
  if (
    Object.keys(input).some((key) => !SHARE_KEYS.has(key)) ||
    !stringWithin(input.path, SHARE_PATH_MAX, true) ||
    !stringWithin(input.name, SHARE_NAME_MAX, false) ||
    !stringWithin(input.description, SHARE_DESCRIPTION_MAX, false)
  ) {
    throw new ToolFailure("invalid input: expected { path, name?, description? }");
  }
  const problem = frameSizeProblem(toolCallId, TOOL_SHARE_FILE, input);
  if (problem !== undefined) throw new ToolFailure(problem);
  const outcome = await transport.request({
    op: OP_FILE_SHARE,
    tool_call_id: toolCallId,
    tool: TOOL_SHARE_FILE,
    input,
  });
  if (!outcome.ok) throw new ToolFailure(`${outcome.error.code}: ${outcome.error.message}`);
  if (!("file_id" in outcome)) throw new ToolFailure("unexpected answer to share_file");
  const { ok: _ok, ...record } = outcome;
  return { content: [{ type: "text", text: JSON.stringify(record) }], details: { ...record } };
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
  if (!("artifact_id" in outcome)) throw new ToolFailure("unexpected answer to the artifact call");
  const result = { artifact_id: outcome.artifact_id, version: outcome.version };
  return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
}

const WEB_SEARCH_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  required: ["query"],
  properties: {
    query: { type: "string", minLength: 1, maxLength: WEB_SEARCH_QUERY_MAX },
    count: {
      type: "integer",
      minimum: 1,
      maximum: WEB_SEARCH_COUNT_MAX,
      description: "How many results to return (default 5).",
    },
  },
};

/** `web_search` (KOBE-114): the server runs the search; this process never sees a key. */
export function webSearchTool(transport: ToolsTransport): ToolDefinitionLike {
  return {
    name: TOOL_WEB_SEARCH,
    label: "Web search",
    description:
      "Search the web. Returns numbered results with title, URL and snippet. If web search is unavailable (not set up for this install or this team) the answer says so; tell the user that and do not guess.",
    promptSnippet: "Search the web and get sources with URLs",
    promptGuidelines: [
      "Use web_search for current or external facts; cite the URL of every source you rely on.",
      "If web_search says it is unavailable, tell the user plainly and work from the material you have.",
    ],
    parameters: WEB_SEARCH_PARAMETERS,
    execute: (toolCallId, params) => webSearch(transport, toolCallId, params),
  };
}

function validSearchInput(input: Record<string, unknown>): boolean {
  const { query, count } = input;
  if (Object.keys(input).some((key) => key !== "query" && key !== "count")) return false;
  if (typeof query !== "string" || query.trim() === "" || query.length > WEB_SEARCH_QUERY_MAX) {
    return false;
  }
  return (
    count === undefined ||
    (Number.isInteger(count) && (count as number) >= 1 && (count as number) <= WEB_SEARCH_COUNT_MAX)
  );
}

async function webSearch(
  transport: ToolsTransport,
  toolCallId: string,
  params: unknown,
): Promise<ToolResultLike> {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw new ToolFailure("invalid input");
  }
  const input = params as Record<string, unknown>;
  if (!validSearchInput(input)) {
    throw new ToolFailure("invalid input: expected { query, count? }");
  }
  const outcome = await transport.request({
    op: OP_WEB_SEARCH,
    tool_call_id: toolCallId,
    tool: TOOL_WEB_SEARCH,
    input,
  });
  if (!outcome.ok) throw new ToolFailure(`${outcome.error.code}: ${outcome.error.message}`);
  if (!("available" in outcome)) throw new ToolFailure("unexpected answer to web_search");
  const { ok: _ok, ...details } = outcome;
  if (!outcome.available) {
    return { content: [{ type: "text", text: outcome.message }], details: { ...details } };
  }
  const lines = outcome.results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`);
  const text =
    lines.length === 0
      ? `No results for "${outcome.query}".`
      : `Results for "${outcome.query}" (cite the URL of each source you use):\n\n${lines.join("\n\n")}`;
  return { content: [{ type: "text", text }], details: { ...details } };
}
