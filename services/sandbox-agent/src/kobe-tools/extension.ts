import { fstatSync } from "node:fs";
import net from "node:net";
import type { Duplex } from "node:stream";
import { ToolsClient, type ToolsClientOptions } from "./client.js";
import { installMemoryHooks, type MemoryHooksApi } from "./memory-hooks.js";
import { recallTool, rememberTool } from "./memory-tools.js";
import { MEMORY_FILE_ENV, TOOLS_FD_ENV, TOOLS_FILES_ENV, TOOLS_MEMORY_ENV } from "./protocol.js";
import {
  artifactTools,
  shareFileTool,
  webSearchTool,
  type ToolDefinitionLike,
  type ToolsTransport,
} from "./tools.js";

/** The slice of Pi's `ExtensionAPI` kobe-tools uses. */
export interface ExtensionApiLike extends Partial<MemoryHooksApi> {
  registerTool(tool: ToolDefinitionLike): unknown;
}

export interface KobeToolsDeps {
  /** `process.env`: the fd variable is read once and deleted, so tools Pi spawns never see it. */
  readonly env: Record<string, string | undefined>;
  readonly openChannel?: (fd: number) => Duplex;
  readonly clientOptions?: ToolsClientOptions;
  readonly warn?: (message: string) => void;
}

/**
 * Connect to the agent's end of the channel. Undefined when there is none (an agent without the
 * `artifacts` capability passes no fd): then no tool is registered, so old agents keep working and
 * the model is never offered a tool that cannot work.
 */
export function connectTools(deps: KobeToolsDeps): ToolsTransport | undefined {
  const raw = deps.env[TOOLS_FD_ENV];
  Reflect.deleteProperty(deps.env, TOOLS_FD_ENV);
  if (raw === undefined) return undefined;
  if (!/^[0-9]{1,4}$/.test(raw) || Number(raw) < 4) {
    deps.warn?.(`kobe-tools: invalid ${TOOLS_FD_ENV}; no tools registered`);
    return undefined;
  }
  try {
    return new ToolsClient((deps.openChannel ?? openSocketFd)(Number(raw)), deps.clientOptions);
  } catch (error) {
    deps.warn?.(
      `kobe-tools: cannot open the channel: ${(error as Error).message}; no tools registered`,
    );
    return undefined;
  }
}

/**
 * Whether the agent enabled `share_file` (it announced the `files` capability to the server).
 * Read once and removed, like the fd variable. Anything but `1` is off, so an old agent, which
 * never sets it, gets no `share_file` from a newer image.
 */
export function filesEnabled(env: Record<string, string | undefined>): boolean {
  const raw = env[TOOLS_FILES_ENV];
  Reflect.deleteProperty(env, TOOLS_FILES_ENV);
  return raw === "1";
}

/** Whether the agent announced the `memory` capability (KOBE_TOOLS_MEMORY=1); read once, removed. */
export function memoryEnabled(env: Record<string, string | undefined>): boolean {
  const raw = env[TOOLS_MEMORY_ENV];
  Reflect.deleteProperty(env, TOOLS_MEMORY_ENV);
  return raw === "1";
}

/** The per-run memory file named by KOBE_MEMORY_FILE; read once and removed like the other variables. */
export function memoryFile(env: Record<string, string | undefined>): string | undefined {
  const raw = env[MEMORY_FILE_ENV];
  Reflect.deleteProperty(env, MEMORY_FILE_ENV);
  return raw === undefined || raw === "" ? undefined : raw;
}

export function registerKobeTools(
  pi: ExtensionApiLike,
  transport: ToolsTransport | undefined,
  options: {
    readonly files?: boolean;
    readonly memory?: boolean;
    readonly memoryFile?: string | undefined;
  } = {},
): void {
  if (transport === undefined) return;
  for (const tool of artifactTools(transport)) pi.registerTool(tool);
  // Always listed: the server answers "unavailable" when the install or team has it off.
  pi.registerTool(webSearchTool(transport));
  if (options.files === true) pi.registerTool(shareFileTool(transport));
  if (options.memory === true) {
    pi.registerTool(rememberTool(transport));
    pi.registerTool(recallTool(transport));
    // Active only for runs that have memory on (the agent says so in the run's memory file).
    if (pi.on && pi.getActiveTools && pi.setActiveTools) {
      installMemoryHooks(pi as MemoryHooksApi, options.memoryFile);
    }
  }
}

/** fd 4 must be the socket the agent passed. */
function openSocketFd(fd: number): Duplex {
  if (!fstatSync(fd).isSocket()) throw new Error(`fd ${fd} is not a socket`);
  const socket = new net.Socket({ fd, readable: true, writable: true });
  // Never keep Pi alive on its own account: Pi's lifetime is its stdin's.
  socket.unref();
  return socket;
}
