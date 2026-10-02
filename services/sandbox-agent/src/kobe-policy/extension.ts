import { fstatSync } from "node:fs";
import net from "node:net";
import type { Duplex } from "node:stream";
import { PolicyClient, type PolicyClientOptions } from "./client.js";
import {
  createToolCallHandler,
  type PolicyChecker,
  type ToolCallBlock,
  type ToolCallContextLike,
  type ToolCallEventLike,
} from "./handler.js";
import { FIRST_REPLY_TIMEOUT_MS, POLICY_FD_ENV, REPLY_TIMEOUT_ENV } from "./protocol.js";
import { findLaunchProblem } from "./self-check.js";

/** The slice of Pi's `ExtensionAPI` kobe-policy uses (structural, so no Pi package dependency). */
export interface ExtensionApiLike {
  on(
    event: "tool_call",
    handler: (
      event: ToolCallEventLike,
      ctx: ToolCallContextLike,
    ) => Promise<ToolCallBlock | undefined>,
  ): unknown;
}

export interface KobePolicyDeps {
  /** `process.env`: the fd variable is read once and deleted, so tools Pi spawns never see it. */
  readonly env: Record<string, string | undefined>;
  readonly argv: readonly string[];
  readonly cwd: string;
  /** This extension's own file, to check it is the last `-e` (see self-check.ts). */
  readonly ownPath: string;
  readonly openChannel?: (fd: number) => Duplex;
  readonly clientOptions?: PolicyClientOptions;
  readonly warn?: (message: string) => void;
}

/** A connected (or failed) channel; `announce` sends `channel.ready` when the launch checked out. */
export interface PolicyConnection {
  readonly checker: PolicyChecker;
  readonly announce: () => void;
}

/**
 * Connect to kobe-sandbox-agent over the inherited channel and complete the handshake. Never throws:
 * a failure yields a checker that blocks every call with the reason (a Pi extension that throws at
 * load is skipped by Pi and the tools would run unchecked — the agent's `channel.ready` wait is the
 * other half of that guarantee). `channel.ready` is not sent here: only once the handler is
 * registered ({@link registerKobePolicy}).
 */
export async function connectPolicy(deps: KobePolicyDeps): Promise<PolicyConnection> {
  const raw = deps.env[POLICY_FD_ENV];
  Reflect.deleteProperty(deps.env, POLICY_FD_ENV);
  const timeout = replyTimeoutOverride(deps.env);
  if (raw === undefined || !/^[0-9]{1,4}$/.test(raw) || Number(raw) < 3) {
    return unavailable(deps, `no policy channel (${POLICY_FD_ENV} not set)`);
  }
  let stream: Duplex;
  try {
    stream = (deps.openChannel ?? openSocketFd)(Number(raw));
  } catch (error) {
    return unavailable(deps, `cannot open the policy channel: ${(error as Error).message}`);
  }
  const client = new PolicyClient(stream, {
    ...deps.clientOptions,
    ...timeout,
  });
  try {
    await client.handshake();
  } catch (error) {
    deps.warn?.(`kobe-policy: ${(error as Error).message}; every tool call will be blocked`);
    return { checker: client, announce: () => undefined };
  }
  const problem = findLaunchProblem(deps.argv, deps.ownPath, deps.cwd);
  if (problem !== undefined) {
    deps.warn?.(`kobe-policy: ${problem}; every tool call will be blocked`);
    client.refuse(problem);
    return { checker: client, announce: () => undefined };
  }
  return { checker: client, announce: () => client.ready() };
}

/**
 * Register the handler, then tell the agent it may use this Pi. In that order: if registering
 * failed, Pi would skip the extension and the agent must not see `channel.ready`. Pi awaits an async
 * factory before startup continues (Pi 1.0.0 docs).
 */
export async function registerKobePolicy(
  pi: ExtensionApiLike,
  connection: Promise<PolicyConnection>,
): Promise<void> {
  const { checker, announce } = await connection;
  pi.on("tool_call", createToolCallHandler(checker));
  announce();
}

/** {@link REPLY_TIMEOUT_ENV}: read once, removed, and only ever shortens the default. */
function replyTimeoutOverride(env: Record<string, string | undefined>): PolicyClientOptions {
  const raw = env[REPLY_TIMEOUT_ENV];
  Reflect.deleteProperty(env, REPLY_TIMEOUT_ENV);
  const ms = raw !== undefined && /^[0-9]{1,9}$/.test(raw) ? Number(raw) : Number.NaN;
  return ms >= 1 && ms < FIRST_REPLY_TIMEOUT_MS ? { firstReplyTimeoutMs: ms } : {};
}

function unavailable(deps: KobePolicyDeps, reason: string): PolicyConnection {
  deps.warn?.(`kobe-policy: ${reason}; every tool call will be blocked`);
  return { checker: { check: async () => ({ allow: false, reason }) }, announce: () => undefined };
}

/** fd 3 must be the socket the agent passed (on Linux an unrelated fd 3 may be libuv's epoll fd). */
function openSocketFd(fd: number): Duplex {
  if (!fstatSync(fd).isSocket()) throw new Error(`fd ${fd} is not a socket`);
  const socket = new net.Socket({ fd, readable: true, writable: true });
  // Never keep Pi alive on its own account: Pi's lifetime is its stdin's.
  socket.unref();
  return socket;
}
