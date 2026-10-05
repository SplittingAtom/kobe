/**
 * The fd-4 channel between the kobe-tools Pi extension and kobe-sandbox-agent (sandbox-internal; the
 * agent side is `tools/channel.ts`; shapes agreed in packages/protocol `artifacts.ts`, KOBE-127).
 * JSONL, LF-split, one JSON object per line, same framing and fail-closed rules as the policy
 * channel.
 *
 *   extension → agent   {"id","op":"artifact.put","tool_call_id","tool","input"}
 *   agent → extension   {"id","ok":true,"artifact_id","version"}
 *                       {"id","ok":false,"error":{"code","message"}}
 *
 * Every op has its own `op` string; `share_file` (KOBE-54) and `remember` (KOBE-56) will add theirs
 * to {@link OPS} and a tool of their own. None is defined here.
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
export const OPS = [OP_ARTIFACT_PUT] as const;

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
  readonly op: typeof OP_ARTIFACT_PUT;
  readonly tool_call_id: string;
  readonly tool: string;
  readonly input: Record<string, unknown>;
}

export interface ToolsError {
  readonly code: string;
  readonly message: string;
}

export type ToolsResponse =
  | {
      readonly id: string;
      readonly ok: true;
      readonly artifact_id: string;
      readonly version: number;
    }
  | { readonly id: string; readonly ok: false; readonly error: ToolsError };
