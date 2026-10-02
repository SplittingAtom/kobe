/**
 * The fd-3 channel between the kobe-policy Pi extension and kobe-sandbox-agent (sandbox-internal; the
 * agent side is `policy/channel.ts`). JSONL, LF-split, one JSON object per line.
 *
 *   agent → extension   {"type":"channel.hello","nonce"}                         first line, once
 *   extension → agent   {"type":"channel.ready","nonce","extension","version"}   load finished
 *   extension → agent   {"type":"channel.refused","nonce","reason"}              self-check failed
 *   extension → agent   {"type":"policy.check","nonce","request_id","tool_call_id",
 *                         "parent_tool_call_id"?,"tool","input"}
 *   agent → extension   {"type":"policy.pending","request_id",…}   a human decides; keep waiting
 *   agent → extension   {"type":"policy.result","request_id","decision","reasons","message"?,…}
 *
 * This file must stay dependency-free (node builtins only): it is part of the extension Pi loads
 * from a root-owned directory with no node_modules.
 */
export const EXTENSION_NAME = "kobe-policy";
export const CHANNEL_VERSION = 1;

export const MSG_HELLO = "channel.hello";
export const MSG_READY = "channel.ready";
export const MSG_REFUSED = "channel.refused";
export const MSG_CHECK = "policy.check";
export const MSG_PENDING = "policy.pending";
export const MSG_RESULT = "policy.result";

/** Env var naming the inherited channel fd. Read once at load and removed from `process.env`. */
export const POLICY_FD_ENV = "KOBE_POLICY_FD";

/**
 * Optional, shortens the wait for a first answer (tests). Never lengthens it, and the agent's
 * allow-listed Pi environment never passes it, so in a sandbox the default always applies.
 */
export const REPLY_TIMEOUT_ENV = "KOBE_POLICY_REPLY_TIMEOUT_MS";

/** One request line, as the agent accepts it (= the wire frame cap). */
export const MAX_REQUEST_LINE_BYTES = 4 * 1024 * 1024;
/** One reply line from the agent; anything longer closes the channel (fail closed). */
export const MAX_REPLY_LINE_BYTES = 1024 * 1024;
/** Checks in flight per Pi process (the agent's per-thread cap). */
export const MAX_PENDING_CHECKS = 128;

/** Wait for `channel.hello` at load. */
export const HELLO_TIMEOUT_MS = 10_000;
/** Wait for the first answer (`policy.pending` or `policy.result`) to a check. */
export const FIRST_REPLY_TIMEOUT_MS = 60_000;
/** Pending approvals live 1 h (D29); the extension waits until `expires_at` plus this grace. */
export const PENDING_GRACE_MS = 60_000;
/** Upper bound on any wait after `policy.pending`, whatever `expires_at` says. */
export const MAX_PENDING_WAIT_MS = 60 * 60_000 + PENDING_GRACE_MS;

/** Pi tool-call ids and wire ids (`idSchema`): 1–128 chars, no control characters. */
export const MAX_ID_LENGTH = 128;
export const MAX_TOOL_NAME_LENGTH = 256;
/** JSON nesting the extension accepts in a tool input (`toolInputSchema` allows 128). */
export const MAX_INPUT_DEPTH = 128;

export interface ReadyMessage {
  readonly type: typeof MSG_READY;
  readonly nonce: string;
  readonly extension: typeof EXTENSION_NAME;
  readonly version: typeof CHANNEL_VERSION;
}

export interface RefusedMessage {
  readonly type: typeof MSG_REFUSED;
  readonly nonce: string;
  readonly reason: string;
}

export interface CheckMessage {
  readonly type: typeof MSG_CHECK;
  readonly nonce: string;
  readonly request_id: string;
  readonly tool_call_id: string;
  readonly parent_tool_call_id?: string;
  readonly tool: string;
  readonly input: Record<string, unknown>;
}

/** Ids as `idSchema` accepts them. */
export function isWireId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= MAX_ID_LENGTH &&
    // eslint-disable-next-line no-control-regex
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}
