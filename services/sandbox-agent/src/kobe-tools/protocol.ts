/**
 * The fd-4 channel between the kobe-tools Pi extension and kobe-sandbox-agent (sandbox-internal; the
 * agent side is `tools/channel.ts`; shapes agreed in packages/protocol `artifacts.ts`, KOBE-127).
 * JSONL, LF-split, one JSON object per line, same framing and fail-closed rules as the policy
 * channel.
 *
 *   extension → agent   {"id","op":"artifact.put","tool_call_id","tool","input"}
 *                       {"id","op":"file.share","tool_call_id","tool":"share_file","input"}
 *   agent → extension   {"id","ok":true,"artifact_id","version"}            (artifact.put)
 *                       {"id","ok":true,"file_id","name","mime_type","size_bytes","scan",
 *                        "created_at","sha256"}                              (file.share)
 *                       {"id","ok":false,"error":{"code","message"}}
 *
 * Every op has its own `op` string; `remember` (KOBE-56) will add its own to {@link OPS} and a tool
 * of its own. `share_file` (KOBE-149) is registered only when the agent sets
 * {@link TOOLS_FILES_ENV} (it announced the `files` capability; the server may then answer it).
 *
 * Dependency-free (node builtins only): the extension ships on its own, root-owned, without
 * node_modules. The values below mirror packages/protocol `artifacts.ts`; a test pins them.
 */
export const EXTENSION_NAME = "kobe-tools";

/** Env var naming the inherited channel fd. Read once at load and removed from `process.env`. */
export const TOOLS_FD_ENV = "KOBE_TOOLS_FD";
export const TOOLS_FD = 4;
export const TOOLS_TIMEOUT_MS = 30_000;

export const OP_ARTIFACT_PUT = "artifact.put";
export const OP_FILE_SHARE = "file.share";
export const OP_WEB_SEARCH = "web_search";
export const OPS = [OP_ARTIFACT_PUT, OP_FILE_SHARE, OP_WEB_SEARCH] as const;

export const TOOL_WEB_SEARCH = "web_search";
/** Mirrors packages/protocol `web-search.ts` (pinned by a test). */
export const WEB_SEARCH_QUERY_MAX = 400;
export const WEB_SEARCH_COUNT_MAX = 10;

/** Env var set to `1` by an agent that announced the `files` capability. Read once, removed. */
export const TOOLS_FILES_ENV = "KOBE_TOOLS_FILES";
export const TOOL_SHARE_FILE = "share_file";
/** Mirrors packages/protocol `files.ts` (pinned by a test). */
export const SHARE_PATH_MAX = 1024;
export const SHARE_DESCRIPTION_MAX = 500;
export const SHARE_NAME_MAX = 255;

export const TOOL_CREATE_ARTIFACT = "create_artifact";
export const TOOL_UPDATE_ARTIFACT = "update_artifact";

/** `artifact.put` and `policy.check` frames: the server closes the connection above 1 MiB. */
export const MAX_FRAME_BYTES = 1024 * 1024;
export const MAX_CONTENT_BYTES = 512 * 1024;
export const MAX_TITLE_LENGTH = 200;
/** One reply line from the agent; anything longer closes the channel (fail closed). */
export const MAX_REPLY_LINE_BYTES = 64 * 1024;
/** Requests in flight per Pi process. */
export const MAX_PENDING_REQUESTS = 16;
export const MAX_ID_LENGTH = 128;

export interface ToolsRequest {
  readonly id: string;
  readonly op: (typeof OPS)[number];
  readonly tool_call_id: string;
  readonly tool: string;
  readonly input: Record<string, unknown>;
}

export interface ToolsError {
  readonly code: string;
  readonly message: string;
}

export interface SharedFileFields {
  readonly file_id: string;
  readonly name: string;
  readonly mime_type: string;
  readonly size_bytes: number;
  readonly scan: string;
  readonly created_at: string;
  readonly sha256: string;
}

export interface WebSearchCitation {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
}

/** `web_search` answers: results, or "unavailable" as a normal answer (web-search.ts). */
export interface WebSearchAnswer {
  readonly ok: true;
  readonly available: true;
  readonly provider: string;
  readonly query: string;
  readonly results: readonly WebSearchCitation[];
}
export interface WebSearchUnavailable {
  readonly ok: true;
  readonly available: false;
  readonly reason: string;
  readonly message: string;
}

export type ToolsResponse =
  | ({ readonly id: string } & WebSearchAnswer)
  | ({ readonly id: string } & WebSearchUnavailable)
  | {
      readonly id: string;
      readonly ok: true;
      readonly artifact_id: string;
      readonly version: number;
    }
  | ({ readonly id: string; readonly ok: true } & SharedFileFields)
  | { readonly id: string; readonly ok: false; readonly error: ToolsError };
