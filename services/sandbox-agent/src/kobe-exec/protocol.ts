/**
 * The exec channel (KOBE-167, docs/design/paired-tool-uid.md option B): how the `kobe-exec` Pi
 * extension asks for Pi's built-in tools to run somewhere that is not Pi. Three parties speak it,
 * all through this file:
 *
 *   kobe-exec (in Pi, fd 5)  <->  kobe-sandbox-agent (relay, exec/relay.ts)  <->  the executor
 *   (exec/executor/, its stdio, running as the Pi identity's partner uid)
 *
 * JSONL, LF-split, one JSON object per line, same framing and fail-closed rules as the policy and
 * tools channels. The agent only validates envelopes (`id`, `op`) and tracks which requests are
 * open; the executor validates everything it acts on.
 *
 *   request   {"id","op":"exec","cwd","command"|"argv","env"?,"timeout_s"?}   stream + final
 *             {"id","op":"cancel","target"}                                    no reply
 *             {"id","op":"read","path","offset","length"}                     {"ok":true,"data","size","eof"}
 *             {"id","op":"write","path","data","append"?}                      {"ok":true}
 *             {"id","op":"mkdir","path"}                                       {"ok":true}
 *             {"id","op":"access","path","write"?}                             {"ok":true}
 *             {"id","op":"stat","path"}                                        {"ok":true,"kind","size"}
 *             {"id","op":"readdir","path"}                                     {"ok":true,"entries":[{"name","dir"}]}
 *   stream    {"id","stream":"stdout"|"stderr","data"}                          (exec only, base64)
 *   final     {"id","ok":true,...} | {"id","ok":false,"error":{"code","message"}}
 *
 * A frame with a boolean `ok` ends its request. Every way a request cannot be answered (executor
 * missing or dead, oversize or malformed frame, timeout) ends it with an error: nothing ever runs
 * in Pi instead.
 *
 * Dependency-free (node builtins only): the extension ships on its own, root-owned, without
 * node_modules, and the executor imports this file straight from the agent's dist.
 */
export const EXTENSION_NAME = "kobe-exec";

/** Env var naming the inherited channel fd. Read once at load and removed from `process.env`. */
export const EXEC_FD_ENV = "KOBE_EXEC_FD";
export const EXEC_FD = 5;
/**
 * Env var (KOBE-196) naming the tools' HOME when Pi's own is private: Pi resolves `~` in the paths
 * of its file tools against its HOME, so the extension maps the private home to this one.
 */
export const TOOL_HOME_ENV = "KOBE_EXEC_TOOL_HOME";

export const OP_EXEC = "exec";
export const OP_CANCEL = "cancel";
export const OP_READ = "read";
export const OP_WRITE = "write";
export const OP_MKDIR = "mkdir";
export const OP_ACCESS = "access";
export const OP_STAT = "stat";
export const OP_READDIR = "readdir";
export const OPS = [
  OP_EXEC,
  OP_CANCEL,
  OP_READ,
  OP_WRITE,
  OP_MKDIR,
  OP_ACCESS,
  OP_STAT,
  OP_READDIR,
] as const;
export type Op = (typeof OPS)[number];

/** File data moves in chunks of this many raw bytes (base64 on the wire). */
export const CHUNK_BYTES = 1024 * 1024;
/** Largest file `read` / `write` handle in one tool call (Pi reads whole files into memory). */
export const MAX_FILE_BYTES = 64 * 1024 * 1024;
/** One request line (a `write` chunk is the largest). */
export const MAX_REQUEST_LINE_BYTES = 2 * 1024 * 1024;
/** One reply line (a `read` chunk is the largest). */
export const MAX_REPLY_LINE_BYTES = 2 * 1024 * 1024;
export const MAX_COMMAND_BYTES = 512 * 1024;
export const MAX_PATH_BYTES = 4096;
/** Requests in flight per Pi (tool calls run in parallel only a few at a time). */
export const MAX_PENDING_REQUESTS = 32;
export const MAX_ID_LENGTH = 128;
/** A request id: what the extension mints (`ke_<n>`); the relay refuses anything else. */
export const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
/** Programs `exec` may run by argv (grep and find); anything else goes through `command`. */
export const ARGV_PROGRAMS: ReadonlySet<string> = new Set(["rg", "fd", "fdfind"]);
/** The only Pi variables the executor passes on to a command (session details for the model). */
export const PASSED_ENV: ReadonlySet<string> = new Set([
  "PI_SESSION_ID",
  "PI_SESSION_FILE",
  "PI_PROVIDER",
  "PI_MODEL",
  "PI_REASONING_LEVEL",
]);

export interface ExecError {
  readonly code: string;
  readonly message: string;
}

export type ExecRequest =
  | {
      readonly id: string;
      readonly op: typeof OP_EXEC;
      readonly cwd: string;
      readonly command?: string;
      readonly argv?: readonly string[];
      readonly env?: Readonly<Record<string, string>>;
      readonly timeout_s?: number;
    }
  | { readonly id: string; readonly op: typeof OP_CANCEL; readonly target: string }
  | {
      readonly id: string;
      readonly op: typeof OP_READ;
      readonly path: string;
      readonly offset: number;
      readonly length: number;
    }
  | {
      readonly id: string;
      readonly op: typeof OP_WRITE;
      readonly path: string;
      readonly data: string;
      readonly append?: boolean;
    }
  | { readonly id: string; readonly op: typeof OP_MKDIR; readonly path: string }
  | {
      readonly id: string;
      readonly op: typeof OP_ACCESS;
      readonly path: string;
      readonly write?: boolean;
    }
  | { readonly id: string; readonly op: typeof OP_STAT; readonly path: string }
  | { readonly id: string; readonly op: typeof OP_READDIR; readonly path: string };

export interface StreamFrame {
  readonly id: string;
  readonly stream: "stdout" | "stderr";
  readonly data: string;
}

export type FinalFrame =
  | { readonly id: string; readonly ok: true; readonly [key: string]: unknown }
  | { readonly id: string; readonly ok: false; readonly error: ExecError };

export type ReplyFrame = StreamFrame | FinalFrame;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function errorFrame(id: string, code: string, message: string): FinalFrame {
  return { id, ok: false, error: { code, message } };
}

/** The envelope the relay needs: a well-formed id and a known op, or undefined. */
export function parseEnvelope(
  value: unknown,
): { readonly id: string; readonly op: Op; readonly raw: Record<string, unknown> } | undefined {
  if (!isRecord(value)) return undefined;
  const { id, op } = value;
  if (typeof id !== "string" || !ID_PATTERN.test(id)) return undefined;
  if (typeof op !== "string" || !(OPS as readonly string[]).includes(op)) return undefined;
  return { id, op: op as Op, raw: value };
}

/** A reply frame as the relay and the extension read it: `id`, and `ok` when it is final. */
export function parseReply(
  value: unknown,
):
  | { readonly id: string; readonly final: boolean; readonly raw: Record<string, unknown> }
  | undefined {
  if (!isRecord(value)) return undefined;
  const { id, ok } = value;
  if (typeof id !== "string" || !ID_PATTERN.test(id)) return undefined;
  if (ok !== undefined && typeof ok !== "boolean") return undefined;
  return { id, final: typeof ok === "boolean", raw: value };
}
