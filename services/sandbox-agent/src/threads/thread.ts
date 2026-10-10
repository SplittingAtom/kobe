import { chmod, chown, mkdir, mkdtemp, stat } from "node:fs/promises";
import path from "node:path";
import {
  piExtensionUiRequestSchema,
  type PiExtensionUiRequest,
  type PiExtensionUiResponse,
  type PiRpcResponse,
} from "@kobe/protocol";
import {
  PolicyChannel,
  type PolicyChannelCheck,
  type PolicyChannelReply,
} from "../policy/channel.js";
import { ToolsChannel } from "../tools/channel.js";
import type {
  KobeToolsRequest,
  KobeToolsResponse,
  RunMcpContext,
  RunMemoryContext,
} from "@kobe/protocol";
import { MEMORY_FILE_ENV, MEMORY_FILE_NAME, MemoryContextFile } from "../memory/context-file.js";
import { memoryRunFileContent } from "../memory/context.js";
import { PiProcess, PiProcessError, type PiExit, type PiRecord } from "../pi/pi-process.js";
import type { PiIdentities, PiIdentity } from "../pi/identities.js";
import type { PiLaunch } from "../pi/pi-launch.js";
import { piCommand } from "../pi/pi-command.js";
import { shareOnVolume } from "../workspace/volume.js";
import { ensureSessionDir } from "../pi/session-files.js";
import { MODEL_FILE_ENV, RUN_TOKEN_UI_TITLE } from "../kobe-models/protocol.js";
import {
  SYSTEM_PROMPT_FILE_NAME,
  SystemPromptFile,
  systemPromptArgs,
} from "../pi/system-prompt-file.js";
import { tamperedConfig, writeGuardedConfig } from "../models/agent-config.js";
import {
  buildPiMcpConfig,
  MCP_AGENT_FILES,
  MCP_CONFIG_FILE,
  MCP_TOKEN_FILE,
  mcpTokenFileText,
  verifyAgentFile,
  writeAgentFile,
  type McpWiring,
} from "../mcp/pi-mcp-config.js";
import { ModelFile } from "../models/model-file.js";
import {
  AGENT_SUBDIR,
  MODEL_FILE_NAME,
  RUNTIME_DIR_PREFIX,
  ensureRuntimeRoot,
  piModelsStoreText,
  removeRuntimeDir,
  unexpectedEntries,
} from "../models/runtime-dir.js";
import type { ModelWiring, RunModel } from "../models/types.js";
import { TOOL_HOME_ENV } from "../kobe-exec/protocol.js";
import type { ExecRelay } from "../exec/relay.js";
import {
  assertPaired,
  openRelay,
  preparePiPrivateDirs,
  prepareToolDir,
  type ExecWiring,
} from "./exec-wiring.js";
import {
  EGRESS_TOKEN_FILE_NAME,
  EgressTokenFile,
  egressEnv,
  type EgressWiring,
} from "../egress/egress-wiring.js";

/**
 * One Kobe thread's Pi process and its active run. All lifecycle changes (spawn, restart, stop,
 * session-file writes) are serialised through `withLock`; Pi requests run outside the lock.
 */
export const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);
export const MAX_PENDING_DIALOGS = 64;
/** Scratch trees every identity can write besides /workspace and $HOME (reclaimed per uid). */
export const SHARED_SCRATCH_DIRS = ["/tmp", "/dev/shm"] as const;
/** Pi startup (extension loading, jiti) up to kobe-policy's `channel.ready`. */
export const POLICY_READY_TIMEOUT_MS = 30_000;

export interface ThreadHooks {
  readonly runStarted: (runId: string, threadId: string) => void;
  readonly piEvent: (runId: string, threadId: string, event: PiRecord) => void;
  readonly runEnded: (runId: string, threadId: string) => void;
  readonly uiRequest: (
    threadId: string,
    runId: string | undefined,
    request: PiExtensionUiRequest,
  ) => void;
  /** `runId`: the run that was active when Pi exited (the thread is leased only through it). */
  readonly piExited: (threadId: string, runId: string | undefined, exit: PiExit) => void;
  readonly policyCheck: (
    threadId: string,
    runId: string | undefined,
    check: PolicyChannelCheck,
    reply: (message: PolicyChannelReply) => void,
  ) => void;
  /** kobe-policy stopped waiting for one of its checks (timeout, Stop): free its slot. */
  readonly policyCancel?: (threadId: string, requestId: string) => void;
  /** The thread's policy channel is unusable: every pending check of the thread is denied. */
  readonly policyChannelClosed: (threadId: string, reason: string) => void;
  /** kobe-tools asked for an artifact (KOBE-128); absent: no tools channel is served. */
  readonly toolsRequest?: (
    threadId: string,
    runId: string | undefined,
    request: KobeToolsRequest,
    reply: (response: KobeToolsResponse) => void,
  ) => void;
  /** The thread's tools channel is unusable: every pending request of the thread fails. */
  readonly toolsChannelClosed?: (threadId: string, reason: string) => void;
  readonly diagnostic: (threadId: string, message: string) => void;
  /** Something went wrong that does not end a run but an operator should see (warn level). */
  readonly warning?: (threadId: string, message: string) => void;
}

/** What the thread keeps of a Pi's `mcp.json` so a rotated token can be written into it. */
interface McpConfigState {
  readonly agentDir: string;
  readonly shared: boolean;
  readonly mcp: RunMcpContext;
  /** `mcp.json` as written (static for this process). */
  readonly config: string;
  /** The last two token file texts written (a rotation may be mid-rename): what the tripwire accepts. */
  tokenTexts: readonly string[];
}

export interface ThreadEnv {
  readonly bin: string;
  /**
   * Parent of the private per-process directories (KOBE-41): each Pi gets a fresh `mkdtemp` dir
   * holding its `PI_CODING_AGENT_DIR` (Pi 1.0.0 writes `auth.json` there on every credential
   * read) and its model file; removed when the process exits. Nothing in it outlives the
   * process, so nothing a tool writes there reaches another thread or a later Pi. ($HOME and
   * /tmp stay shared, see docs/ledger/KOBE-71.md.)
   */
  readonly runtimeDir: string;
  /** Model gateway wiring; absent when this sandbox has no model access. */
  readonly models?: ModelWiring | undefined;
  /** Egress for Pi's tools (KOBE-39): token file + BASH_ENV; absent outside Kobe's pods. */
  readonly egress?: EgressWiring | undefined;
  /** mcp-proxy wiring for Pi's per-session MCP config (KOBE-111); absent: no connector tools. */
  readonly mcp?: McpWiring | undefined;
  /** The kobe-policy extension (root-owned file), loaded last into every Pi (KOBE-36). */
  readonly policyExtension: string;
  /** The kobe-tools extension (root-owned file, KOBE-128); absent: no tools, no fd 4. */
  readonly toolsExtension?: string | undefined;
  /** The agent announced the `files` capability: the extension registers `share_file` (KOBE-149). */
  readonly shareFiles?: boolean | undefined;
  /** The agent announced `projects` (KOBE-162): kobe-tools registers `propose_project_file`. */
  readonly projectTools?: boolean | undefined;
  /** The agent announced `memory` (KOBE-157): kobe-tools registers remember/recall. */
  readonly memoryTools?: boolean | undefined;
  /** Other root-owned extension paths loaded with `-e`, before kobe-policy. */
  readonly extensions?: readonly string[];
  /** How long a new Pi may take to report kobe-policy ready (default {@link POLICY_READY_TIMEOUT_MS}). */
  readonly policyReadyTimeoutMs?: number;
  readonly workspaceDir: string;
  readonly sessionDir: string;
  readonly home: string;
  /**
   * Pi identities (KOBE-71): each Pi process runs as one of them, with a runtime directory, HOME
   * and TMPDIR of its own that no other thread's process can reach. Absent: Pi runs as the
   * agent's own uid (development, tests outside the image).
   */
  readonly identities?: PiIdentities | undefined;
  /**
   * The tool executor (KOBE-167): present, a Pi started with the kobe-exec extension gets the fd-5
   * relay and its tools run in an executor under its partner uid. Absent: Pi runs its own tools.
   */
  readonly exec?: ExecWiring | undefined;
  /**
   * The scratch volume (the pod's /tmp) Pi's private HOME and TMPDIR are made on when the tools run
   * in the executor (KOBE-196). Default `/tmp`.
   */
  readonly piPrivateRoot?: string | undefined;
  /** The kobe-exec extension (root-owned file); loaded into every Pi when `exec` is set. */
  readonly execExtension?: string | undefined;
}

/** A Pi process's private directory and the identity it runs as (if any). */
interface RuntimeOf {
  readonly dir: string;
  readonly identity: PiIdentity | undefined;
  /** The partner-readable directory beside `dir` (the egress token), under paired identities. */
  readonly toolDir?: string | undefined;
  /** Pi's private HOME/TMPDIR root beside `dir` (KOBE-196), under paired identities. */
  readonly piDir?: string | undefined;
  readonly relay?: ExecRelay | undefined;
}

interface ActiveRun {
  readonly runId: string;
  stopAfterStep: boolean;
  stopping: boolean;
  readonly ended: Promise<void>;
  readonly resolveEnded: () => void;
}

export class Thread {
  readonly id: string;
  readonly #env: ThreadEnv;
  readonly #hooks: ThreadHooks;
  #pi: PiProcess | undefined;
  #policy: PolicyChannel | undefined;
  #launchKey: string | undefined;
  /** The current Pi's model file (undefined without model wiring). */
  #modelFile: ModelFile | undefined;
  /** The active run's gateway token (KOBE-118): held in memory for this thread's Pi only. */
  #runToken: { readonly runId: string; readonly token: string } | undefined;
  /** Where the current Pi's `mcp.json` lives and what it was built from (KOBE-111). */
  #mcpConfig: McpConfigState | undefined;
  /** The current Pi's egress token file (undefined without egress wiring). */
  #egressFile: EgressTokenFile | undefined;
  #promptFile: SystemPromptFile | undefined;
  #memoryFile: MemoryContextFile | undefined;
  /** Each process's private runtime directory (and identity), removed once it has exited. */
  readonly #runtimeDirs = new Map<PiProcess, RuntimeOf>();
  /** Removal of a runtime directory in progress (awaited by `stopProcess`). */
  readonly #removals = new Map<PiProcess, Promise<void>>();
  #closing = new Set<PiProcess>();
  #run: ActiveRun | undefined;
  #streaming = false;
  #dialogs = new Map<string, PiExtensionUiRequest>();
  #lock: Promise<unknown> = Promise.resolve();
  #inflight = 0;
  /** Commands in progress on this thread (taken synchronously when a command arrives). */
  #claims = 0;
  lastUsed = Date.now();
  restoring = false;

  constructor(id: string, env: ThreadEnv, hooks: ThreadHooks) {
    this.id = id;
    this.#env = env;
    this.#hooks = hooks;
  }

  get runId(): string | undefined {
    return this.#run?.runId;
  }

  get hasProcess(): boolean {
    return this.#pi !== undefined;
  }

  /** kobe-policy in the current Pi reported ready and its channel is still open. */
  get policyUsable(): boolean {
    return this.#policy?.ready === true && !this.#policy.closed;
  }

  get launchKey(): string | undefined {
    return this.#launchKey;
  }

  get streaming(): boolean {
    return this.#streaming;
  }

  /** Busy threads are never evicted or reaped. */
  get busy(): boolean {
    return (
      this.#run !== undefined ||
      this.#streaming ||
      this.restoring ||
      this.#inflight > 0 ||
      this.#claims > 0
    );
  }

  /**
   * Mark the thread busy for the duration of a command, from the moment it arrives, so the reaper
   * and the process cap never stop (or forget) a thread a queued command is about to use.
   */
  claim(): () => void {
    this.#claims += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#claims -= 1;
    };
  }

  get pendingDialogs(): PiExtensionUiRequest[] {
    return [...this.#dialogs.values()];
  }

  withLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#lock.then(fn, fn);
    this.#lock = next.catch(() => undefined);
    return next;
  }

  /**
   * Spawn Pi with `launch` (call inside the lock). `model` is the run's model when known at spawn
   * (a `run.start`); a Pi started for a `pi.command` gets none until its first run.
   */
  async spawn(launch: PiLaunch, model: RunModel | null = null): Promise<void> {
    const identities = this.#env.identities;
    await ensureSessionDir(this.#env.sessionDir, {
      shared: identities !== undefined,
      workspaceDir: this.#env.workspaceDir,
    });
    await mkdir(this.#env.home, { recursive: true }).catch(() => undefined);
    // Shared by every thread (the pod's home volume is; one the agent made itself must be too).
    if (identities !== undefined) await shareOnVolume(this.#env.home, this.#env.home, 0o2770);
    await ensureRuntimeRoot(this.#env.runtimeDir, identities !== undefined);
    const exec = launch.execChannel ? this.#env.exec : undefined;
    if (launch.execChannel && exec === undefined) {
      throw new Error("the launch asks for kobe-exec but this agent has no tool executor");
    }
    if (exec !== undefined) assertPaired(identities);
    const identity = await identities?.acquire();
    let runtimeDir: string | undefined;
    let toolDir: string | undefined;
    let piDir: string | undefined;
    let relay: ExecRelay | undefined;
    let pi: PiProcess;
    let modelFile: ModelFile | undefined;
    let mcpConfig: McpConfigState | undefined;
    let egressFile: EgressTokenFile | undefined;
    let promptFile: SystemPromptFile | undefined;
    let memoryFile: MemoryContextFile | undefined;
    try {
      runtimeDir = await mkdtemp(path.join(this.#env.runtimeDir, RUNTIME_DIR_PREFIX));
      const env: Record<string, string> = { ...launch.env };
      const agentDir = path.join(runtimeDir, AGENT_SUBDIR);
      if (identity === undefined) {
        await mkdir(agentDir, { mode: 0o700 });
      } else {
        await this.#prepareIdentityDirs(runtimeDir, identity);
      }
      await writeGuardedConfig(agentDir, identity !== undefined);
      env.PI_CODING_AGENT_DIR = agentDir;
      // Per-session MCP (KOBE-111): the file goes into this process's private config dir, the one
      // place Pi reads `mcp.json`; the workspace and the shared HOME are never involved.
      if (launch.mcp !== undefined) {
        const wiring = this.#env.mcp;
        if (wiring === undefined) throw new Error("this sandbox has no MCP proxy wiring");
        const config = buildPiMcpConfig({
          proxyUrl: wiring.proxyUrl,
          tokenFile: path.join(agentDir, MCP_TOKEN_FILE),
          mcp: launch.mcp,
        });
        const tokenText = mcpTokenFileText(await wiring.tokens.current());
        mcpConfig = {
          agentDir,
          shared: identity !== undefined,
          mcp: launch.mcp,
          config,
          tokenTexts: [tokenText],
        };
        // Token first: Pi may run the header command as soon as it reads the config.
        await writeAgentFile(agentDir, MCP_TOKEN_FILE, tokenText, mcpConfig.shared);
        await writeAgentFile(agentDir, MCP_CONFIG_FILE, config, mcpConfig.shared);
      }
      // The tools get the launch's HOME and TMPDIR (the shared ones); Pi gets private ones, as it
      // loads code from both. With the executor the tools are another uid; without it (KOBE-228)
      // they are Pi's own and inherit its environment, so the shared ones reach them through the
      // BASH_ENV script (`KOBE_TOOL_HOME`/`KOBE_TOOL_TMPDIR`).
      const toolEnvBase = { ...env };
      const priv = await preparePiPrivateDirs(
        this.#env.piPrivateRoot ?? "/tmp",
        runtimeDir,
        identity,
        { partner: exec !== undefined },
      );
      piDir = priv.root;
      env.HOME = priv.home;
      env.TMPDIR = priv.tmp;
      if (exec !== undefined) {
        // `~` in the file tools is resolved by Pi: tell kobe-exec where the tools' home is.
        if (toolEnvBase.HOME !== undefined) env[TOOL_HOME_ENV] = toolEnvBase.HOME;
      } else {
        if (toolEnvBase.HOME !== undefined) env.KOBE_TOOL_HOME = toolEnvBase.HOME;
        // No TMPDIR in the launch: the tools' scratch is /tmp, never Pi's private (deleted) one.
        env.KOBE_TOOL_TMPDIR = toolEnvBase.TMPDIR ?? "/tmp";
      }
      const models = this.#env.models;
      if (models !== undefined) {
        modelFile = new ModelFile(
          path.join(runtimeDir, MODEL_FILE_NAME),
          {
            gatewayUrl: models.gatewayUrl,
            model,
            token: await models.tokens.current(),
            runId: null,
          },
          identity === undefined ? 0o600 : 0o640,
        );
        await modelFile.create();
        env[MODEL_FILE_ENV] = modelFile.path;
      }
      const command = await piCommand(this.#env.bin, launch.env.PATH);
      const egress = this.#env.egress;
      let egressVars: Record<string, string> = {};
      if (egress !== undefined) {
        // With the executor the tools are not Pi's: the token lives where their uid (and not
        // Pi) can read it, and the variables go to the executor, not to Pi.
        if (exec !== undefined && identity !== undefined) {
          toolDir = await prepareToolDir(runtimeDir, identity);
        }
        egressFile = new EgressTokenFile(
          path.join(toolDir ?? runtimeDir, EGRESS_TOKEN_FILE_NAME),
          identity === undefined ? 0o600 : 0o640,
        );
        await egressFile.write(await egress.tokens.current());
        egressVars = egressEnv(egress, egressFile.path, this.id);
        if (exec === undefined) Object.assign(env, egressVars);
      }
      if (launch.systemPrompt !== undefined) {
        promptFile = new SystemPromptFile(
          path.join(runtimeDir, SYSTEM_PROMPT_FILE_NAME),
          launch.systemPrompt,
          identity === undefined ? 0o600 : 0o640,
        );
        await promptFile.write();
      }
      if (launch.memoryFile) {
        // Memory off until the run says otherwise (attachMemory, before every prompt).
        memoryFile = new MemoryContextFile(
          path.join(runtimeDir, MEMORY_FILE_NAME),
          identity === undefined ? 0o600 : 0o640,
        );
        await memoryFile.write({ tools: false, text: "" });
        env[MEMORY_FILE_ENV] = memoryFile.path;
      }
      pi = new PiProcess({
        bin: command.bin,
        args: [
          ...command.prefix,
          ...launch.args,
          ...(promptFile === undefined ? [] : systemPromptArgs(promptFile.path)),
        ],
        cwd: this.#env.workspaceDir,
        env,
        onEvent: (event) => this.#onEvent(pi, event),
        onUiRequest: (request) => this.#onUiRequest(pi, request),
        onExit: (exit) => this.#onExit(pi, exit),
        onDiagnostic: (message) => this.#hooks.diagnostic(this.id, message),
        ...(launch.toolsChannel ? { toolsChannel: true } : {}),
        ...(exec === undefined ? {} : { execChannel: true }),
        ...(identity === undefined || identities === undefined
          ? {}
          : { runAs: { identities, identity } }),
      });
      if (exec !== undefined) {
        try {
          relay = openRelay({
            pi,
            wiring: exec,
            launchEnv: toolEnvBase,
            egress: egressVars,
            cwd: this.#env.workspaceDir,
            runAs:
              identity === undefined || identities === undefined
                ? undefined
                : { identities, identity },
            onDiagnostic: (message) => this.#hooks.diagnostic(this.id, message),
          });
        } catch (error) {
          // A Pi whose tools have nowhere to go must not run: its own would be the fallback.
          this.#closing.add(pi);
          pi.kill();
          await pi.whenExited();
          this.#closing.delete(pi);
          throw error;
        }
      }
    } catch (error) {
      // Nothing of a Pi that never started may stay behind (the token included).
      if (runtimeDir !== undefined) {
        const removed = await removeDirs([runtimeDir, toolDir, piDir], identities);
        // A directory the next holder of the identity could read: keep the identity out of use.
        if (removed && identity !== undefined) identities?.release(identity);
      } else if (identity !== undefined) {
        identities?.release(identity);
      }
      throw error;
    }
    this.#runtimeDirs.set(pi, { dir: runtimeDir, identity, toolDir, piDir, relay });
    const control = pi.control;
    let channel: PolicyChannel | undefined;
    if (control !== undefined) {
      const opened: PolicyChannel = new PolicyChannel(control, {
        onCheck: (check) =>
          this.#hooks.policyCheck(this.id, this.#run?.runId, check, (m) => opened.reply(m)),
        onCancel: (requestId) => this.#hooks.policyCancel?.(this.id, requestId),
        onClosed: (reason) => this.#hooks.policyChannelClosed(this.id, reason),
        onDiagnostic: (message) => this.#hooks.diagnostic(this.id, message),
      });
      channel = opened;
    }
    const toolsControl = pi.toolsControl;
    if (toolsControl !== undefined) {
      const opened: ToolsChannel = new ToolsChannel(toolsControl, {
        onRequest: (request, reply) =>
          this.#hooks.toolsRequest?.(this.id, this.#run?.runId, request, reply),
        onClosed: (reason) => this.#hooks.toolsChannelClosed?.(this.id, reason),
        onDiagnostic: (message) => this.#hooks.diagnostic(this.id, message),
      });
      void opened;
    }
    this.#pi = pi;
    this.#policy = channel;
    this.#launchKey = launch.key;
    this.#modelFile = modelFile;
    this.#mcpConfig = mcpConfig;
    this.#egressFile = egressFile;
    this.#promptFile = promptFile;
    this.#memoryFile = memoryFile;
    this.lastUsed = Date.now();
    // A token rotated while this spawn was in progress reached no file (the listener runs only
    // against `#modelFile`): take the current token again now that the file is attached.
    const models = this.#env.models;
    if (modelFile !== undefined && models !== undefined) {
      try {
        await modelFile.update({ token: await models.tokens.current() });
      } catch (error) {
        // No Pi stays attached without a trustworthy model file: stop it, its dir goes with it.
        await this.stopProcess();
        throw error;
      }
    }
    // Same for the egress token (a failed write only warns: the old token is still valid a while).
    const egress = this.#env.egress;
    if (egressFile !== undefined && egress !== undefined) {
      await this.updateEgressToken(await egress.tokens.current());
    }
  }

  /**
   * A rotated mcp-proxy token (KOBE-111): the token file is rewritten atomically. Pi's header
   * command reads it whenever Pi opens a connection (mcp-proxy makes an expired session reconnect).
   */
  async updateMcpToken(token: string): Promise<void> {
    const state = this.#mcpConfig;
    if (state === undefined) return;
    try {
      const text = mcpTokenFileText(token);
      state.tokenTexts = [state.tokenTexts.at(-1) ?? text, text];
      await writeAgentFile(state.agentDir, MCP_TOKEN_FILE, text, state.shared);
    } catch (error) {
      this.#warn(`mcp config not updated: ${(error as Error).message}`);
    }
  }

  /** A rotated egress token: the next bash tool call's shell reads it (KOBE-39). */
  async updateEgressToken(token: string): Promise<void> {
    try {
      await this.#egressFile?.write(token);
    } catch (error) {
      this.#warn(`egress token file not updated: ${(error as Error).message}`);
    }
  }

  /**
   * Under a Pi identity: the runtime directory becomes the agent's with the Pi's own group
   * (setgid, 2750: the Pi reads it, nobody else gets in), with `agent/` the only place that Pi
   * may write (3770, sticky: it cannot rename or delete the agent's guarded files there, see
   * models/agent-config.ts; Pi 1.0.0 writes its credential and catalog stores there).
   */
  async #prepareIdentityDirs(runtimeDir: string, identity: PiIdentity): Promise<void> {
    await chown(runtimeDir, -1, identity.gid);
    await chmod(runtimeDir, 0o2750);
    const agentDir = path.join(runtimeDir, AGENT_SUBDIR);
    await mkdir(agentDir);
    await chmod(agentDir, 0o3770);
  }

  /**
   * The tripwire (KOBE-41 review): the private runtime directory may only hold what the agent
   * and Pi wrote, and the model file must be what the agent last wrote. Under Pi identities
   * (KOBE-71) no other thread can write it at all and nobody but the agent can write the model
   * file; what remains is this Pi's own tools writing its `agent/` dir (`settings.json`,
   * `models.json`, `SYSTEM.md`, which Pi 1.0.0 must be able to write into). Without identities a
   * sibling thread's tool could do the same. Either way such a Pi is stopped and its run fails
   * `runtime_tampered`. Checked once Pi is ready and again right before every prompt. Returns the
   * reason, or undefined. A detector, not a boundary: see docs/ledger/KOBE-71.md.
   */
  async verifyRuntime(): Promise<string | undefined> {
    const pi = this.#pi;
    const runtimeDir = pi === undefined ? undefined : this.#runtimeDirs.get(pi)?.dir;
    if (runtimeDir === undefined) return undefined;
    // The agent's own pending writes first (temp file + rename), then the listing.
    if (this.#modelFile !== undefined && !(await this.#modelFile.verify())) {
      return "the model file is not what the agent wrote";
    }
    if (this.#egressFile !== undefined && !(await this.#egressFile.verify())) {
      return "the egress token file is not what the agent wrote";
    }
    if (this.#promptFile !== undefined && !(await this.#promptFile.verify())) {
      return "the system prompt file is not what the agent wrote";
    }
    if (this.#memoryFile !== undefined && !(await this.#memoryFile.verify())) {
      return "the memory context file is not what the agent wrote";
    }
    const mcp = this.#mcpConfig;
    if (
      mcp !== undefined &&
      !(
        (await verifyAgentFile(mcp.agentDir, MCP_CONFIG_FILE, [mcp.config])) &&
        (await verifyAgentFile(mcp.agentDir, MCP_TOKEN_FILE, mcp.tokenTexts))
      )
    ) {
      return "the MCP config or token file is not what the agent wrote";
    }
    const unexpected = await unexpectedEntries(
      runtimeDir,
      mcp === undefined ? undefined : MCP_AGENT_FILES,
    );
    if (unexpected.length > 0) {
      return `unexpected entries in Pi's runtime directory: ${unexpected.slice(0, 5).join(", ")}`;
    }
    const changed = await tamperedConfig(path.join(runtimeDir, AGENT_SUBDIR));
    if (changed.length > 0) {
      return `${changed.join(", ")} is not what the agent wrote (KOBE-169)`;
    }
    // Pi reads its catalog store back on every refresh; an offline Pi with no dynamic provider
    // never persists an entry (the file is absent or `{}`), so any entry was planted.
    const store = await piModelsStoreText(runtimeDir);
    if (store !== null && store !== "{}") return "Pi's models-store.json holds catalog entries";
    return undefined;
  }

  /**
   * Stop this thread's Pi for a tampered runtime found around a command that could make it use
   * planted config (audit: a warning with the reason; the caller fails the command with
   * `runtime_tampered`, which the server records).
   */
  async stopTampered(reason: string, during: string): Promise<void> {
    this.#warn(`runtime_tampered during ${during}: ${reason}; Pi stopped`);
    await this.withLock(() => this.stopProcess());
  }

  /**
   * Make `runId` the run Pi attributes its model calls to (`x-kobe-run-id`), with the run's
   * model, before the prompt is sent. The extension reads the file on Pi's `input` hook and per
   * request. No-op without model wiring.
   */
  async attachRun(
    runId: string,
    model: RunModel | null,
    runToken?: string | undefined,
  ): Promise<void> {
    // Memory only (KOBE-118): handed to this Pi on request, never written anywhere.
    this.#runToken = runToken === undefined ? undefined : { runId, token: runToken };
    await this.#modelFile?.update({ runId, model });
  }

  /**
   * The run's memory (KOBE-157): the kobe-tools extension lists `remember` / `recall` and adds the
   * fenced index to the run's prompt only while this says so. A per-run file, not a launch input.
   */
  async attachMemory(memory: RunMemoryContext | undefined): Promise<void> {
    await this.#memoryFile?.write(memoryRunFileContent(memory));
  }

  /** A rotated model-gateway token: the next model request uses it (the current one is not cut). */
  async updateToken(token: string): Promise<void> {
    try {
      await this.#modelFile?.update({ token });
    } catch (error) {
      this.#warn(`model file not updated with the rotated token: ${(error as Error).message}`);
    }
  }

  #warn(message: string): void {
    (this.#hooks.warning ?? this.#hooks.diagnostic)(this.id, message);
  }

  /** Where the current Pi's model file is (tests and diagnostics). */
  get modelFilePath(): string | undefined {
    return this.#modelFile?.path;
  }

  /**
   * Wait until kobe-policy in the current Pi reported `channel.ready` (call inside the lock, right
   * after {@link spawn}). No prompt reaches a Pi whose policy extension did not load and self-check:
   * without it Pi would run tools unchecked.
   */
  async waitPolicyReady(): Promise<void> {
    const channel = this.#policy;
    if (channel === undefined) throw new Error("Pi has no policy channel");
    await channel.waitReady(this.#env.policyReadyTimeoutMs ?? POLICY_READY_TIMEOUT_MS);
  }

  /** Stop the Pi process (call inside the lock). Ends the active run, if any. */
  async stopProcess(): Promise<void> {
    const pi = this.#pi;
    if (pi === undefined) return;
    this.#closing.add(pi);
    this.#detach(pi);
    await pi.close();
    // Its runtime directory (token, config) is gone before anything else starts.
    await this.#removals.get(pi);
  }

  /** Synchronous kill for agent exit. */
  kill(): void {
    this.#pi?.kill();
  }

  async request(command: Record<string, unknown>, timeoutMs: number): Promise<PiRpcResponse> {
    const pi = this.#pi;
    if (pi === undefined) throw new PiProcessError("Pi process is not running", "pi_unavailable");
    this.lastUsed = Date.now();
    this.#inflight += 1;
    try {
      return await pi.request(command, timeoutMs);
    } finally {
      this.#inflight -= 1;
      this.lastUsed = Date.now();
    }
  }

  beginRun(runId: string): void {
    let resolveEnded: () => void = () => undefined;
    const ended = new Promise<void>((resolve) => {
      resolveEnded = resolve;
    });
    this.#run = { runId, stopAfterStep: false, stopping: false, ended, resolveEnded };
    this.onStopDue = undefined;
    this.lastUsed = Date.now();
    this.#hooks.runStarted(runId, this.id);
  }

  endRun(): void {
    const run = this.#run;
    if (run === undefined) return;
    this.#run = undefined;
    this.#runToken = undefined;
    this.lastUsed = Date.now();
    this.#modelFile
      ?.update({ runId: null })
      .catch((error: unknown) =>
        this.#warn(`model file not updated at run end: ${(error as Error).message}`),
      );
    this.#hooks.runEnded(run.runId, this.id);
    run.resolveEnded();
  }

  runEnded(): Promise<void> {
    return this.#run?.ended ?? Promise.resolve();
  }

  /**
   * Stop after the in-flight step: abort on the next `turn_end` (or the run settles first). Never
   * "now": Pi answers `prompt` before it emits `agent_start`, so a stop that arrives in between would
   * otherwise see an idle-looking thread and abort a step that is about to run.
   */
  markStopAfterStep(): void {
    const run = this.#run;
    if (run !== undefined) run.stopAfterStep = true;
  }

  /** Mark the run as stopping; false when a stop is already under way. */
  beginStopping(): boolean {
    const run = this.#run;
    if (run === undefined || run.stopping) return false;
    run.stopping = true;
    return true;
  }

  answerDialog(response: PiExtensionUiResponse): boolean {
    if (!this.#dialogs.delete(response.id)) return false;
    this.#pi?.send(response);
    return true;
  }

  /** Called when an abort is due after `turn_end`; set by the manager. */
  onStopDue: (() => void) | undefined;

  #onEvent(pi: PiProcess, event: PiRecord): void {
    if (pi !== this.#pi) return;
    this.lastUsed = Date.now();
    if (event.type === "agent_start") this.#streaming = true;
    const run = this.#run;
    if (run !== undefined) this.#hooks.piEvent(run.runId, this.id, event);
    if (event.type === "turn_end" && run?.stopAfterStep === true && !run.stopping) {
      this.onStopDue?.();
    }
    if (event.type === "agent_settled") {
      this.#streaming = false;
      if (run !== undefined && this.#run === run) this.endRun();
    }
  }

  #onUiRequest(pi: PiProcess, record: PiRecord): void {
    if (pi !== this.#pi) return;
    if (record.method === "input" && record.title === RUN_TOKEN_UI_TITLE) {
      this.#answerRunToken(pi, record);
      return;
    }
    const parsed = piExtensionUiRequestSchema.safeParse(record);
    if (!parsed.success) {
      const id = typeof record.id === "string" ? record.id : undefined;
      if (id !== undefined) pi.send({ type: "extension_ui_response", id, cancelled: true });
      this.#hooks.diagnostic(this.id, "unsupported extension UI request cancelled");
      return;
    }
    const request = parsed.data;
    const runId = this.#run?.runId;
    if (runId === undefined) {
      // The server leases a thread only through a run: with none active nobody may answer.
      if (DIALOG_METHODS.has(request.method)) this.#cancelDialog(pi, request.id);
      return;
    }
    if (DIALOG_METHODS.has(request.method)) {
      if (this.#dialogs.size >= MAX_PENDING_DIALOGS) {
        pi.send({ type: "extension_ui_response", id: request.id, cancelled: true });
        return;
      }
      this.#dialogs.set(request.id, request);
    }
    this.#hooks.uiRequest(this.id, runId, request);
  }

  /**
   * kobe-models asks for the run's gateway token (KOBE-118). Answered here, never relayed to the
   * server: the token for the active run, else a cancel (no run, no token, an older server).
   */
  #answerRunToken(pi: PiProcess, record: PiRecord): void {
    const id = typeof record.id === "string" ? record.id : undefined;
    if (id === undefined) return;
    const held = this.#runToken;
    if (held !== undefined && held.runId === this.#run?.runId) {
      pi.send({ type: "extension_ui_response", id, value: held.token });
    } else {
      pi.send({ type: "extension_ui_response", id, cancelled: true });
    }
  }

  /** Cancel open dialogs (their run is no longer leased to this connection). */
  cancelDialogs(): void {
    const pi = this.#pi;
    for (const id of [...this.#dialogs.keys()]) {
      this.#dialogs.delete(id);
      if (pi !== undefined) this.#cancelDialog(pi, id);
    }
  }

  #cancelDialog(pi: PiProcess, id: string): void {
    pi.send({ type: "extension_ui_response", id, cancelled: true });
  }

  #onExit(pi: PiProcess, exit: PiExit): void {
    const expected = this.#closing.delete(pi);
    const runId = pi === this.#pi ? this.#run?.runId : undefined;
    if (pi === this.#pi) this.#detach(pi);
    const runtime = this.#runtimeDirs.get(pi);
    this.#runtimeDirs.delete(pi);
    // The tools stop with their Pi (the executor is killed; under an identity the uid pair is
    // killed below, before the identity can go to another thread).
    runtime?.relay?.close("Pi exited");
    // The process is gone: so is its private directory (auth.json, model file, token), and under
    // a Pi identity every process of its uid, before the identity can go to another thread.
    if (runtime !== undefined) {
      const removal = this.#reclaim(runtime).finally(() => this.#removals.delete(pi));
      this.#removals.set(pi, removal);
    }
    if (!expected) this.#hooks.piExited(this.id, runId, exit);
  }

  async #reclaim(runtime: RuntimeOf): Promise<void> {
    const identities = this.#env.identities;
    const identity = runtime.identity;
    if (identity !== undefined && identities !== undefined) {
      try {
        await identities.killAllPatiently(identity);
        // Pi's private HOME/TMPDIR go first: the reclaim below opens what the uid owns in the
        // shared trees to the workspace group, and these sit under one of them.
        if (runtime.piDir !== undefined) await removeRuntimeDir(runtime.piDir, identities);
        // What the uid still owns in the shared trees becomes the workspace group's (nothing
        // stays private to it for the next thread that gets the uid), its IPC objects go.
        const gid = (await stat(this.#env.workspaceDir)).gid;
        await identities.reclaimFiles(
          identity,
          gid,
          [this.#env.workspaceDir, this.#env.home, ...SHARED_SCRATCH_DIRS],
          // The runtime root is a small sticky tmpfs shared by all Pis: what the uid left at its
          // top level (owner-only files, a filled disk) must not reach the next holder.
          { purgeDirs: [this.#env.runtimeDir] },
        );
      } catch (error) {
        // Its processes or private files may remain: the identity is never handed out again.
        this.#warn(`Pi identity ${identity.uid} not reclaimed: ${(error as Error).message}`);
        return;
      }
    }
    try {
      // (Under an identity it is already gone, removed before the reclaim.)
      if (identity === undefined && runtime.piDir !== undefined) {
        await removeRuntimeDir(runtime.piDir, identities);
      }
      await removeRuntimeDir(runtime.dir, identities);
      if (runtime.toolDir !== undefined) await removeRuntimeDir(runtime.toolDir, identities);
    } catch (error) {
      this.#warn(`runtime directory not removed: ${(error as Error).message}`);
      // A directory the next holder of the identity could read: keep the identity out of use.
      if (identity !== undefined) return;
    }
    if (identity !== undefined) identities?.release(identity);
  }

  #detach(pi: PiProcess): void {
    if (pi !== this.#pi) return;
    this.#pi = undefined;
    this.#policy = undefined;
    this.#launchKey = undefined;
    this.#modelFile = undefined;
    this.#mcpConfig = undefined;
    this.#egressFile = undefined;
    this.#promptFile = undefined;
    this.#memoryFile = undefined;
    this.#streaming = false;
    this.#dialogs.clear();
    this.endRun();
  }
}

/** Remove runtime directories (the second is optional); true when every one is gone. */
async function removeDirs(
  dirs: readonly (string | undefined)[],
  identities: PiIdentities | undefined,
): Promise<boolean> {
  let all = true;
  for (const dir of dirs) {
    if (dir === undefined) continue;
    const removed = await removeRuntimeDir(dir, identities).then(
      () => true,
      () => false,
    );
    all = all && removed;
  }
  return all;
}
