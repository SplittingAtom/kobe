import path from "node:path";
import type { ExecTransport, Outcome } from "./client.js";
import {
  CHUNK_BYTES,
  MAX_FILE_BYTES,
  OP_ACCESS,
  OP_EXEC,
  OP_MKDIR,
  OP_READ,
  OP_READDIR,
  OP_STAT,
  OP_WRITE,
  PASSED_ENV,
} from "./protocol.js";

/**
 * Pi's tool `operations` (verified Pi 1.0.0, core/tools/{bash,read,write,edit,ls}.js), backed by
 * the executor over the exec channel instead of `node:fs` / `child_process` in Pi's own process.
 * Pi's tool code (path handling, truncation, notices, diffs, details) stays Pi's: only the
 * primitives below move. Errors keep the errno `code` and message the executor's `fs` produced, so
 * Pi's messages (for example edit's "Could not edit file: x. Error code: ENOENT.") read the same.
 */
export class RemoteError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

type Failure = Extract<Outcome, { ok: false }>;

/** The error a failed request becomes. An unavailable executor says nothing ran. */
export function toError(outcome: Failure): Error {
  const { code, message } = outcome.error;
  if (code === "unavailable") {
    return new RemoteError(
      `The tool executor is unavailable (${message}); the tool did not run.`,
      code,
    );
  }
  return new RemoteError(message, code);
}

async function call(
  transport: ExecTransport,
  body: { readonly op: string } & Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Readonly<Record<string, unknown>>> {
  const outcome = await transport.request(body, { signal });
  if (!outcome.ok) throw toError(outcome);
  return outcome.fields;
}

export async function readFileBuffer(
  transport: ExecTransport,
  file: string,
  signal?: AbortSignal,
): Promise<Buffer> {
  const parts: Buffer[] = [];
  let total = 0;
  for (;;) {
    const fields = await call(
      transport,
      { op: OP_READ, path: file, offset: total, length: CHUNK_BYTES },
      signal,
    );
    const data = Buffer.from(String(fields.data ?? ""), "base64");
    total += data.length;
    if (total > MAX_FILE_BYTES) {
      throw new RemoteError(
        `File is too large to read (limit ${MAX_FILE_BYTES / 1024 / 1024} MiB): ${file}`,
        "EFBIG",
      );
    }
    parts.push(data);
    if (fields.eof === true || data.length === 0) return Buffer.concat(parts, total);
  }
}

export async function writeFileText(
  transport: ExecTransport,
  file: string,
  content: string,
  signal?: AbortSignal,
): Promise<void> {
  const bytes = Buffer.from(content, "utf-8");
  if (bytes.length > MAX_FILE_BYTES) {
    throw new RemoteError(
      `Content is too large to write (limit ${MAX_FILE_BYTES / 1024 / 1024} MiB): ${file}`,
      "EFBIG",
    );
  }
  let offset = 0;
  do {
    const chunk = bytes.subarray(offset, offset + CHUNK_BYTES);
    await call(
      transport,
      {
        op: OP_WRITE,
        path: file,
        data: chunk.toString("base64"),
        ...(offset > 0 ? { append: true } : {}),
      },
      signal,
    );
    offset += chunk.length;
  } while (offset < bytes.length);
}

export async function pathAccess(
  transport: ExecTransport,
  file: string,
  write: boolean,
): Promise<void> {
  await call(transport, { op: OP_ACCESS, path: file, write });
}

export async function pathExists(transport: ExecTransport, file: string): Promise<boolean> {
  const outcome = await transport.request({ op: OP_ACCESS, path: file });
  if (outcome.ok) return true;
  // Only "it is not there" is a no; a dead executor must not read as a missing path.
  if (outcome.error.code === "unavailable") throw toError(outcome);
  return false;
}

const MAX_TIMEOUT_S = 2_147_483.647;

/** Pi's own timeout validation (bash.js resolveTimeoutMs), so the messages match. */
function checkTimeout(timeout: number | undefined): void {
  if (timeout === undefined) return;
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new Error("Invalid timeout: must be a finite number of seconds");
  }
  if (timeout > MAX_TIMEOUT_S)
    throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_S} seconds`);
}

export interface ExecOptions {
  readonly onData: (data: Buffer) => void;
  readonly signal?: AbortSignal | undefined;
  readonly timeout?: number | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
}

/** Only the session variables of Pi's environment travel; the executor has its own environment. */
export function passedEnv(env: NodeJS.ProcessEnv | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env ?? {})) {
    if (PASSED_ENV.has(name) && typeof value === "string") out[name] = value;
  }
  return out;
}

export function bashOperations(transport: ExecTransport) {
  return {
    async exec(
      command: string,
      cwd: string,
      { onData, signal, timeout, env }: ExecOptions,
    ): Promise<{ exitCode: number | null }> {
      checkTimeout(timeout);
      if (signal?.aborted === true) throw new Error("aborted");
      const outcome = await transport.request(
        {
          op: OP_EXEC,
          cwd,
          command,
          env: passedEnv(env),
          ...(timeout === undefined ? {} : { timeout_s: timeout }),
        },
        { signal, onStream: (_stream, data) => onData(data) },
      );
      if (outcome.ok) {
        const code = outcome.fields.exit_code;
        return { exitCode: typeof code === "number" ? code : null };
      }
      if (outcome.error.code === "aborted") throw new Error("aborted");
      if (outcome.error.code === "timeout") throw new Error(outcome.error.message);
      throw toError(outcome);
    },
  };
}

export function readOperations(
  transport: ExecTransport,
  detect: (head: Buffer) => Promise<string | null>,
) {
  return {
    readFile: (file: string) => readFileBuffer(transport, file),
    access: (file: string) => pathAccess(transport, file, false),
    // Pi sniffs the first bytes of the file; so does this, on bytes the executor read.
    detectImageMimeType: async (file: string): Promise<string | null> => {
      const fields = await call(transport, { op: OP_READ, path: file, offset: 0, length: 4100 });
      return detect(Buffer.from(String(fields.data ?? ""), "base64"));
    },
  };
}

export function writeOperations(transport: ExecTransport) {
  return {
    writeFile: (file: string, content: string) => writeFileText(transport, file, content),
    mkdir: async (dir: string) => {
      await call(transport, { op: OP_MKDIR, path: dir });
    },
  };
}

export function editOperations(transport: ExecTransport) {
  return {
    readFile: (file: string) => readFileBuffer(transport, file),
    writeFile: (file: string, content: string) => writeFileText(transport, file, content),
    // Pi's edit checks read and write access.
    access: (file: string) => pathAccess(transport, file, true),
  };
}

const LISTING_TTL_MS = 5_000;

/**
 * ls: one `readdir` carries every entry's kind, and the per-entry `stat` Pi's tool then asks for is
 * answered from that listing for a few seconds instead of one round trip per entry.
 */
export function lsOperations(transport: ExecTransport, now: () => number = Date.now) {
  const kinds = new Map<string, { dir: boolean | null; at: number }>();
  return {
    exists: (file: string) => pathExists(transport, file),
    async stat(file: string): Promise<{ isDirectory: () => boolean }> {
      const known = kinds.get(file);
      if (known !== undefined && now() - known.at < LISTING_TTL_MS) {
        if (known.dir === null) {
          throw new RemoteError(`ENOENT: no such file or directory, stat '${file}'`, "ENOENT");
        }
        const dir = known.dir;
        return { isDirectory: () => dir };
      }
      const fields = await call(transport, { op: OP_STAT, path: file });
      const dir = fields.kind === "dir";
      return { isDirectory: () => dir };
    },
    async readdir(dir: string): Promise<string[]> {
      const fields = await call(transport, { op: OP_READDIR, path: dir });
      const entries = Array.isArray(fields.entries) ? fields.entries : [];
      const at = now();
      for (const [key, value] of kinds) if (at - value.at >= LISTING_TTL_MS) kinds.delete(key);
      const names: string[] = [];
      for (const entry of entries as { name?: unknown; dir?: unknown }[]) {
        if (typeof entry.name !== "string") continue;
        names.push(entry.name);
        kinds.set(path.join(dir, entry.name), {
          dir: typeof entry.dir === "boolean" ? entry.dir : null,
          at,
        });
      }
      return names;
    },
  };
}
