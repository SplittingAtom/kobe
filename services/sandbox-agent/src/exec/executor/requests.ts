import {
  ARGV_PROGRAMS,
  CHUNK_BYTES,
  MAX_COMMAND_BYTES,
  MAX_PATH_BYTES,
  OP_ACCESS,
  OP_CANCEL,
  OP_EXEC,
  OP_MKDIR,
  OP_READ,
  OP_READDIR,
  OP_STAT,
  OP_WRITE,
  PASSED_ENV,
  isRecord,
  parseEnvelope,
  type ExecRequest,
} from "../../kobe-exec/protocol.js";

/** Longest timeout Node's timers take, in seconds (Pi's bash tool has the same limit). */
const MAX_TIMEOUT_S = 2_147_483.647;
const MAX_ENV_VALUE_BYTES = 4096;
const MAX_ARGV = 64;
const MAX_ARG_BYTES = 8192;

export class RequestError extends Error {
  constructor(
    readonly id: string | undefined,
    message: string,
  ) {
    super(message);
  }
}

function text(
  raw: Record<string, unknown>,
  key: string,
  maxBytes: number,
  id: string,
): string {
  const value = raw[key];
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new RequestError(id, `${key} must be a non-empty string without NUL`);
  }
  if (Buffer.byteLength(value) > maxBytes) throw new RequestError(id, `${key} is too long`);
  return value;
}

function absolutePath(raw: Record<string, unknown>, key: string, id: string): string {
  const value = text(raw, key, MAX_PATH_BYTES, id);
  if (!value.startsWith("/")) throw new RequestError(id, `${key} must be an absolute path`);
  return value;
}

function integer(
  raw: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
  id: string,
): number {
  const value = raw[key];
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw new RequestError(id, `${key} must be an integer in [${min}, ${max}]`);
  }
  return value as number;
}

/** Only the session variables Pi may pass on; anything else the request names is dropped. */
function passedEnv(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isRecord(value)) return out;
  for (const [name, entry] of Object.entries(value)) {
    if (!PASSED_ENV.has(name) || typeof entry !== "string") continue;
    if (entry.includes("\0") || Buffer.byteLength(entry) > MAX_ENV_VALUE_BYTES) continue;
    out[name] = entry;
  }
  return out;
}

function execRequest(raw: Record<string, unknown>, id: string): ExecRequest {
  const cwd = absolutePath(raw, "cwd", id);
  const hasCommand = raw.command !== undefined;
  const hasArgv = raw.argv !== undefined;
  if (hasCommand === hasArgv) throw new RequestError(id, "exactly one of command and argv");
  let timeout: number | undefined;
  if (raw.timeout_s !== undefined) {
    const value = raw.timeout_s;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > MAX_TIMEOUT_S) {
      throw new RequestError(id, "timeout_s must be a positive number of seconds");
    }
    timeout = value;
  }
  const base = {
    id,
    op: OP_EXEC,
    cwd,
    env: passedEnv(raw.env),
    ...(timeout === undefined ? {} : { timeout_s: timeout }),
  } as const;
  if (hasCommand) return { ...base, command: text(raw, "command", MAX_COMMAND_BYTES, id) };
  const argv = raw.argv;
  if (!Array.isArray(argv) || argv.length === 0 || argv.length > MAX_ARGV) {
    throw new RequestError(id, "argv must be a short non-empty array");
  }
  for (const arg of argv) {
    if (typeof arg !== "string" || arg.includes("\0") || Buffer.byteLength(arg) > MAX_ARG_BYTES) {
      throw new RequestError(id, "argv holds an invalid argument");
    }
  }
  if (!ARGV_PROGRAMS.has(argv[0] as string)) {
    throw new RequestError(id, `argv[0] must be one of ${[...ARGV_PROGRAMS].join(", ")}`);
  }
  return { ...base, argv: argv as string[] };
}

/** A request line as the executor acts on it; throws {@link RequestError} (with the id if known). */
export function parseRequest(value: unknown): ExecRequest {
  const envelope = parseEnvelope(value);
  if (envelope === undefined) {
    const id = isRecord(value) && typeof value.id === "string" ? value.id : undefined;
    throw new RequestError(id, "malformed request");
  }
  const { id, op, raw } = envelope;
  switch (op) {
    case OP_EXEC:
      return execRequest(raw, id);
    case OP_CANCEL:
      return { id, op, target: text(raw, "target", 128, id) };
    case OP_READ:
      return {
        id,
        op,
        path: absolutePath(raw, "path", id),
        offset: integer(raw, "offset", 0, Number.MAX_SAFE_INTEGER, id),
        length: integer(raw, "length", 1, CHUNK_BYTES, id),
      };
    case OP_WRITE: {
      const data = raw.data;
      if (typeof data !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
        throw new RequestError(id, "data must be base64");
      }
      if (raw.append !== undefined && typeof raw.append !== "boolean") {
        throw new RequestError(id, "append must be a boolean");
      }
      return {
        id,
        op,
        path: absolutePath(raw, "path", id),
        data,
        ...(raw.append === undefined ? {} : { append: raw.append }),
      };
    }
    case OP_MKDIR:
    case OP_STAT:
    case OP_READDIR:
      return { id, op, path: absolutePath(raw, "path", id) };
    case OP_ACCESS:
      if (raw.write !== undefined && typeof raw.write !== "boolean") {
        throw new RequestError(id, "write must be a boolean");
      }
      return {
        id,
        op,
        path: absolutePath(raw, "path", id),
        ...(raw.write === undefined ? {} : { write: raw.write }),
      };
  }
}
