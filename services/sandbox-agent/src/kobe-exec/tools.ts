import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExecTransport } from "./client.js";
import {
  bashOperations,
  editOperations,
  lsOperations,
  readOperations,
  writeOperations,
} from "./remote-ops.js";
import { executeFind, executeGrep, type SearchHelpers } from "./search.js";

/**
 * The seven built-in tools of Pi 1.0.0 (`allToolNames` minus the Windows-only `powershell`, which
 * throws on Linux): bash, read, write, edit, ls, grep, find. Registering a tool under a built-in's
 * name replaces it (agent-session.js `_refreshToolRegistry`: extension tools win), so every call
 * goes through kobe-policy's `tool_call` check as before and then to {@link ExecTransport}.
 * bash, read, write, edit and ls are Pi's own tool definitions (same schema, description, prompt
 * text, renderers, truncation and result details) with Kobe operations; grep and find keep Pi's
 * definition and swap `execute` (see search.ts for why).
 */
export const TOOL_NAMES = ["bash", "read", "write", "edit", "ls", "grep", "find"] as const;

/** The slice of Pi's `ExtensionAPI` kobe-exec uses. */
export interface ExtensionApiLike {
  registerTool(tool: never): unknown;
  on?(event: "user_bash", handler: () => unknown): unknown;
}

export interface PiToolFactories extends SearchHelpers {
  createBashToolDefinition(cwd: string, options?: { operations?: unknown }): ToolLike;
  createReadToolDefinition(cwd: string, options?: { operations?: unknown }): ToolLike;
  createWriteToolDefinition(cwd: string, options?: { operations?: unknown }): ToolLike;
  createEditToolDefinition(cwd: string, options?: { operations?: unknown }): ToolLike;
  createLsToolDefinition(cwd: string, options?: { operations?: unknown }): ToolLike;
  createGrepToolDefinition(cwd: string, options?: { operations?: unknown }): ToolLike;
  createFindToolDefinition(cwd: string, options?: { operations?: unknown }): ToolLike;
  detectSupportedImageMimeTypeFromFile(filePath: string): Promise<string | null>;
}

export interface ToolLike {
  readonly name: string;
  readonly [key: string]: unknown;
  execute(
    toolCallId: string,
    params: never,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: { readonly cwd?: string } | undefined,
  ): Promise<unknown>;
}

/** Pi's image sniffing, applied to bytes the executor read (it only takes a file path). */
function imageDetector(pi: PiToolFactories): (head: Buffer) => Promise<string | null> {
  return async (head) => {
    const dir = await mkdtemp(path.join(tmpdir(), "kobe-exec-"));
    try {
      const file = path.join(dir, "head");
      await writeFile(file, head, { mode: 0o600 });
      return await pi.detectSupportedImageMimeTypeFromFile(file);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
}

/** Pi's own home (private) and the tools' (shared), when they differ (KOBE-196). */
export interface Homes {
  readonly piHome: string;
  readonly toolHome: string;
}

const underHome = (value: unknown, home: string): value is string =>
  typeof value === "string" && (value === home || value.startsWith(`${home}/`));

/**
 * Pi resolves `~` in its file tools' paths against its own HOME, which is private to it when the
 * tools run elsewhere: a path under it is the tools' home to the executor (the user's files live
 * there). Only `path` and `cwd` fields are rewritten; Pi's private home holds nothing to read.
 */
export function mapHome(transport: ExecTransport, { piHome, toolHome }: Homes): ExecTransport {
  const map = (value: string) => `${toolHome}${value.slice(piHome.length)}`;
  return {
    request(body, hooks) {
      const mapped: Record<string, unknown> = { ...body };
      for (const key of ["path", "cwd"]) {
        const value = mapped[key];
        if (underHome(value, piHome)) mapped[key] = map(value);
      }
      return transport.request(mapped as typeof body, hooks);
    },
  };
}

export function registerExecTools(
  api: ExtensionApiLike,
  rawTransport: ExecTransport,
  pi: PiToolFactories,
  cwd: string = process.cwd(),
  homes?: Homes,
): void {
  const mapped = homes !== undefined && homes.piHome !== homes.toolHome;
  const transport = mapped ? mapHome(rawTransport, homes) : rawTransport;
  const toolHome = mapped ? homes.toolHome : undefined;
  const bash = bashOperations(transport);
  const register = (tool: ToolLike) => api.registerTool(tool as never);
  register(pi.createBashToolDefinition(cwd, { operations: bash }));
  register(
    pi.createReadToolDefinition(cwd, {
      operations: readOperations(transport, imageDetector(pi)),
    }),
  );
  register(pi.createWriteToolDefinition(cwd, { operations: writeOperations(transport) }));
  register(pi.createEditToolDefinition(cwd, { operations: editOperations(transport) }));
  register({
    ...pi.createLsToolDefinition(cwd, { operations: lsOperations(transport) }),
    defaultActive: false,
  });
  // Pi leaves grep, find and ls inactive by default; registering them must not switch them on.
  const grep = pi.createGrepToolDefinition(cwd);
  register({
    ...grep,
    defaultActive: false,
    execute: (_id, params, signal, _onUpdate, ctx) =>
      executeGrep(transport, pi, params as never, ctx?.cwd || cwd, signal, toolHome),
  });
  const find = pi.createFindToolDefinition(cwd);
  register({
    ...find,
    defaultActive: false,
    execute: (_id, params, signal, _onUpdate, ctx) =>
      executeFind(transport, pi, params as never, ctx?.cwd || cwd, signal, toolHome),
  });
  // The RPC `bash` command (the server never sends it; the allow-list has no such command) and
  // user `!` commands would run in Pi: route them to the executor as well.
  api.on?.("user_bash", () => ({ operations: bash }));
}
