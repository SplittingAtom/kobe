import type { Readable, Writable } from "node:stream";
import { LineSplitter } from "../../jsonl.js";
import {
  MAX_REPLY_LINE_BYTES,
  MAX_REQUEST_LINE_BYTES,
  OP_ACCESS,
  OP_CANCEL,
  OP_EXEC,
  OP_MKDIR,
  OP_READ,
  OP_READDIR,
  OP_STAT,
  OP_WRITE,
  errorFrame,
  type ExecRequest,
  type FinalFrame,
  type ReplyFrame,
} from "../../kobe-exec/protocol.js";
import { runCommand, type RunningCommand } from "./command.js";
import {
  OperationError,
  checkAccess,
  listDirectory,
  makeDirs,
  readChunk,
  statPath,
  toExecError,
  writeChunk,
} from "./files.js";
import { RequestError, parseRequest } from "./requests.js";

/**
 * The executor's request loop (KOBE-167): reads JSONL requests from `input`, performs them as the
 * uid it runs under (the Pi identity's partner uid in a Kobe pod), writes JSONL replies to
 * `output`. Knows nothing about Pi. The commands it starts get `commandEnv` (an allow-list the
 * agent built: no Pi variable, no secret but the egress wiring the tools are meant to have) plus
 * the few session variables a request may name.
 *
 * Fail closed: a request it cannot parse or perform gets an error reply; when `input` ends it kills
 * what it started and `done` resolves.
 */
export interface ExecutorOptions {
  readonly input: Readable;
  readonly output: Writable;
  readonly commandEnv: Readonly<Record<string, string | undefined>>;
  readonly log?: (message: string) => void;
}

export interface Executor {
  /** Resolves once input has ended and every started command has been killed. */
  readonly done: Promise<void>;
}

export function serveExecutor(options: ExecutorOptions): Executor {
  const running = new Map<string, RunningCommand>();
  let drainWaiters: (() => void)[] = [];
  let ended = false;
  const { output } = options;

  const send = (frame: ReplyFrame): boolean => {
    if (ended && output.destroyed) return false;
    const line = `${JSON.stringify(frame)}\n`;
    if (Buffer.byteLength(line) > MAX_REPLY_LINE_BYTES) {
      // Never send what the relay would close the channel over.
      const id = (frame as { id: string }).id;
      return output.write(`${JSON.stringify(errorFrame(id, "too_large", "reply too large"))}\n`);
    }
    return output.write(line);
  };
  output.on("drain", () => {
    const waiters = drainWaiters;
    drainWaiters = [];
    for (const resume of waiters) resume();
  });
  output.on("error", () => undefined);

  const final = (frame: FinalFrame) => void send(frame);

  const handleExec = (request: Extract<ExecRequest, { op: "exec" }>) => {
    const command = runCommand(request, options.commandEnv, {
      onData: (stream, chunk) => send({ id: request.id, stream, data: chunk.toString("base64") }),
      whenDrained: (resume) => drainWaiters.push(resume),
    });
    running.set(request.id, command);
    void command.done.then((outcome) => {
      running.delete(request.id);
      if (outcome.kind === "exit") {
        final({ id: request.id, ok: true, exit_code: outcome.exitCode, signal: outcome.signal });
      } else {
        final({ id: request.id, ok: false, error: outcome.error });
      }
    });
  };

  const perform = async (request: ExecRequest): Promise<Record<string, unknown>> => {
    switch (request.op) {
      case OP_READ:
        return { ...(await readChunk(request.path, request.offset, request.length)) };
      case OP_WRITE:
        await writeChunk(request.path, request.data, request.append === true);
        return {};
      case OP_MKDIR:
        await makeDirs(request.path);
        return {};
      case OP_ACCESS:
        await checkAccess(request.path, request.write === true);
        return {};
      case OP_STAT:
        return { ...(await statPath(request.path)) };
      case OP_READDIR:
        return { ...(await listDirectory(request.path)) };
      default:
        throw new OperationError({ code: "invalid", message: "unsupported operation" });
    }
  };

  const handle = (request: ExecRequest) => {
    if (request.op === OP_CANCEL) {
      running.get(request.target)?.abort();
      return;
    }
    if (running.has(request.id)) {
      final(errorFrame(request.id, "invalid", "duplicate request id"));
      return;
    }
    if (request.op === OP_EXEC) {
      handleExec(request);
      return;
    }
    void perform(request).then(
      (fields) => final({ id: request.id, ok: true, ...fields }),
      (error: unknown) =>
        final({
          id: request.id,
          ok: false,
          error: error instanceof OperationError ? error.error : toExecError(error),
        }),
    );
  };

  const splitter = new LineSplitter({
    maxLineBytes: MAX_REQUEST_LINE_BYTES,
    onLine: (line) => {
      try {
        handle(parseRequest(JSON.parse(line) as unknown));
      } catch (error) {
        if (error instanceof RequestError) {
          if (error.id !== undefined) final(errorFrame(error.id, "invalid", error.message));
          options.log?.(`rejected a request: ${error.message}`);
        } else {
          options.log?.(`unparsable request line: ${(error as Error).message}`);
        }
      }
    },
    onOversize: (bytes) => options.log?.(`dropped an oversize request (${bytes} bytes)`),
  });

  const done = new Promise<void>((resolve) => {
    const finish = () => {
      if (ended) return;
      ended = true;
      splitter.end();
      for (const command of running.values()) command.abort();
      resolve();
    };
    options.input.on("data", (chunk: Buffer) => splitter.push(chunk));
    options.input.on("end", finish);
    options.input.on("close", finish);
    options.input.on("error", finish);
  });
  return { done };
}
