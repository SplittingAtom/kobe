import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EXAMPLE_IDS } from "@kobe/protocol/testing";
import { Agent, type WorkspaceHooks } from "../agent.js";
import { loadConfig } from "../config.js";
import { FakeServer, type FakeServerOptions } from "./fake-server.js";
import type { EgressWiring } from "../egress/egress-wiring.js";
import type { ModelWiring } from "../models/types.js";
import type { PiIdentities } from "../pi/identities.js";
import type { SkillStore } from "../skills/store.js";
import type { ExecWiring } from "../threads/exec-wiring.js";

export const FAKE_PI = fileURLToPath(new URL("./fake-pi.mjs", import.meta.url));
export const TOKEN = "test-wire-token-0123456789";
export const SANDBOX_ID = EXAMPLE_IDS.sandbox;
export const THREAD = EXAMPLE_IDS.thread;
export const THREAD_2 = "2d3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f61";
export const RUN = EXAMPLE_IDS.run;
export const RUN_2 = "3e4f5a6b-7c8d-4e9f-8a1b-2c3d4e5f6072";

export const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  debug: () => undefined,
};

export interface Harness {
  readonly server: FakeServer;
  readonly agent: Agent;
  readonly dir: string;
  readonly workspace: string;
  readonly sessions: string;
  readonly exits: number[];
  commandsLog(threadId?: string): Promise<Record<string, unknown>[]>;
  close(): Promise<void>;
}

export interface HarnessOptions {
  readonly server?: Partial<FakeServerOptions>;
  readonly env?: Record<string, string>;
  readonly piBin?: string;
  readonly heartbeatTimeoutMs?: number;
  readonly policyReadyTimeoutMs?: number;
  readonly extensions?: readonly string[];
  /** Model gateway wiring (KOBE-41); absent = no model access, as before. */
  readonly models?: ModelWiring;
  /** Egress wiring for Pi's tools (KOBE-39); absent = none, as before. */
  readonly egress?: EgressWiring;
  readonly workspace?: (workspaceDir: string) => WorkspaceHooks;
  /**
   * Pi identities (KOBE-71): Pi runs under them, so the test directories are opened up the way
   * the pod's volumes are (traversable; the workspace group-writable and setgid), the token file
   * stays the agent's own, and runtime dirs go to `runtimeDir` if given (another filesystem).
   */
  readonly identities?: PiIdentities;
  readonly runtimeDir?: string;
  /** kobe-tools (KOBE-128): the extension file; absent = no fd 4 and no `artifacts` capability. */
  readonly toolsExtension?: string;
  /** Skills store (KOBE-82); absent = this sandbox cannot materialize skills. */
  readonly skills?: SkillStore;
  /** The tool executor (KOBE-167); absent = Pi runs its own tools, as before. */
  readonly exec?: { readonly extension: string; readonly wiring: ExecWiring };
}

/** The fake Pi ignores the file; it plays kobe-policy's handshake itself (see fake-pi.mjs). */
export const FAKE_POLICY_EXTENSION = "/opt/kobe/pi-extensions/kobe-policy/index.js";

export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const server = await FakeServer.start({ token: TOKEN, ...options.server });
  const dir = await mkdtemp(path.join(tmpdir(), "kobe-agent-"));
  const workspace = path.join(dir, "workspace");
  const sessions = path.join(workspace, ".kobe", "sessions");
  await mkdir(workspace, { recursive: true });
  const tokenFile = path.join(dir, "token");
  await writeFile(tokenFile, `${TOKEN}\n`, { mode: 0o600 });
  if (options.identities !== undefined) {
    await chmod(dir, 0o755);
    await chmod(workspace, 0o2775);
  }
  const config = loadConfig({
    KOBE_SERVER_URL: server.url,
    KOBE_SANDBOX_ID: SANDBOX_ID,
    KOBE_SANDBOX_TOKEN_FILE: tokenFile,
    KOBE_WORKSPACE_DIR: workspace,
    KOBE_SESSION_DIR: sessions,
    KOBE_PI_BIN: options.piBin ?? FAKE_PI,
    // Each Pi gets a private directory under here (its PI_CODING_AGENT_DIR and model file).
    KOBE_PI_RUNTIME_DIR: options.runtimeDir ?? path.join(dir, "pi-runtime"),
    KOBE_POLICY_EXTENSION: FAKE_POLICY_EXTENSION,
    ...options.env,
  });
  const exits: number[] = [];
  const agent = new Agent({
    config,
    logger: silentLogger,
    readToken: async () => (await readFile(tokenFile, "utf8")).trim(),
    agentVersion: "0.0.0-test",
    piVersion: "1.0.0",
    home: path.join(dir, "home"),
    parentEnv: { PATH: process.env.PATH, SECRET_IN_AGENT_ENV: "must-not-leak" },
    onExit: (code) => exits.push(code),
    backoff: { baseMs: 20, maxMs: 100, floorMs: 10 },
    ...(options.heartbeatTimeoutMs === undefined
      ? {}
      : { heartbeatTimeoutMs: options.heartbeatTimeoutMs }),
    ...(options.extensions === undefined ? {} : { extensions: options.extensions }),
    ...(options.models === undefined ? {} : { models: options.models }),
    ...(options.egress === undefined ? {} : { egress: options.egress }),
    ...(options.identities === undefined ? {} : { identities: options.identities }),
    ...(options.toolsExtension === undefined ? {} : { toolsExtension: options.toolsExtension }),
    ...(options.skills === undefined ? {} : { skills: options.skills }),
    ...(options.exec === undefined ? {} : { exec: options.exec }),
    ...(options.workspace === undefined ? {} : { workspace: options.workspace(workspace) }),
    ...(options.policyReadyTimeoutMs === undefined
      ? {}
      : { policyReadyTimeoutMs: options.policyReadyTimeoutMs }),
  });
  agent.start();
  await server.waitFor((f) => f.type === "hello");
  return {
    server,
    agent,
    dir,
    workspace,
    sessions,
    exits,
    async commandsLog(threadId = THREAD) {
      const text = await readFile(path.join(sessions, `${threadId}.jsonl.commands.jsonl`), "utf8");
      return text
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    },
    async close() {
      await agent.stop(500);
      await server.stop();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** Poll until `check` holds (never a fixed sleep before a positive assertion). */
export async function until(check: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 10));
  }
}

export function runStart(message: string, extra: Record<string, unknown> = {}) {
  return { type: "run.start", run_id: RUN, thread_id: THREAD, message, ...extra };
}
