import { constants } from "node:fs";
import { access, mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Agent, type AgentDeps } from "./agent.js";
import { loadConfig, type Config } from "./config.js";
import { hardenProcess } from "./harden.js";
import { logger } from "./logger.js";
import { sweepRuntimeDir } from "./models/runtime-dir.js";
import { ModelTokenKeeper } from "./models/token-keeper.js";
import type { EgressWiring } from "./egress/egress-wiring.js";
import type { ModelWiring } from "./models/types.js";
import { loadPiIdentities, type PiIdentities } from "./pi/identities.js";
import { buildPiLaunch } from "./pi/pi-launch.js";
import { checkExtensionFile, checkPolicyExtensionFile } from "./policy/extension-file.js";
import { SessionClient } from "./session/exchange.js";
import { createSkillFetcher } from "./skills/client.js";
import { SkillStore } from "./skills/store.js";
import { piVersion as readPiVersion, readAgentVersion } from "./version.js";
import { SyncClient } from "./workspace/client.js";
import { WorkspaceSync } from "./workspace/sync.js";

/**
 * kobe-sandbox-agent entry point: the sandbox's main process (D13). Dials out to the server; opens
 * no listening socket. Exits non-zero on invalid configuration (fail fast).
 */
const SHUTDOWN_DEADLINE_MS = 10_000;

async function main(): Promise<void> {
  hardenProcess(process);
  const loaded = loadConfig(process.env);
  // Fail fast: without kobe-policy no thread could start (KOBE-36), so say why at startup. Pi gets
  // the resolved path.
  const checked = {
    ...loaded,
    policyExtension: await checkPolicyExtensionFile(loaded.policyExtension),
    // Set (the image does) means wanted: a file the sandbox user could edit fails startup.
    ...(loaded.toolsExtension === undefined
      ? {}
      : { toolsExtension: await checkExtensionFile(loaded.toolsExtension, "kobe-tools") }),
  };
  const home = process.env.HOME ?? "/home/kobe";
  // KOBE-71: private by default; what Pi identities must reach (workspace files, session files,
  // runtime dirs) gets its mode explicitly.
  process.umask(0o077);
  // Pi identities first: they decide how the runtime directories are laid out, and an agent that
  // was asked for them but cannot provide them must not start Pi under the agent's uid instead.
  const identities = await piIdentities(checked);
  // The tool executor (KOBE-167) needs the pairs from the pod spec: decided right after.
  const exec = await toolExecutor(checked, identities);
  // Pi's private runtime directories live here: leftovers of an earlier agent (a pod restart)
  // are swept first, so no stale token outlives its process; the version probe gets its own dir.
  const swept = await sweepRuntimeDir(checked.piRuntimeDir, { identities });
  if (swept > 0) logger.warn({ removed: swept }, "removed stale Pi runtime directories");
  const probeDir = path.join(checked.piRuntimeDir, "version-probe");
  await mkdir(probeDir, { recursive: true, mode: 0o700 });
  const piEnv = {
    ...buildPiLaunch({
      sessionFile: "-",
      // The probe runs as the agent: nothing of the (world-writable) home volume reaches it.
      home: probeDir,
      policyExtension: checked.policyExtension,
      parentEnv: process.env,
    }).env,
    PI_CODING_AGENT_DIR: probeDir,
  };
  // Kobe's pods carry a bootstrap token only: trade it for the sandbox id and session tokens
  // (retried until the server assigns this pod) before dialling the wire. In parallel with the
  // version probes: both sit on the cold-start path (D14).
  const session =
    loaded.bootstrapTokenFile === undefined
      ? undefined
      : new SessionClient({
          serverUrl: loaded.serverUrl,
          bootstrapTokenFile: loaded.bootstrapTokenFile,
          logger,
        });
  const [agentVersion, piVersion, grant, models, egress] = await Promise.all([
    readAgentVersion(new URL("../package.json", import.meta.url)),
    readPiVersion(loaded.piBin, piEnv),
    session?.grant(),
    modelWiring(checked, session),
    egressWiring(checked, session),
  ]);
  const config = grant ? { ...checked, sandboxId: grant.sandboxId } : checked;
  logger.info(
    {
      server: config.connectUrl,
      sandbox_id: config.sandboxId,
      agentVersion,
      piVersion,
      models: models === undefined ? "off" : models.gatewayUrl,
      egress: egress === undefined ? "off" : egress.proxyUrl,
    },
    "sandbox-agent starting",
  );

  const readToken = session
    ? () => session.wireToken()
    : async () => {
        const token = (await readFile(config.tokenFile, "utf8")).trim();
        if (token === "") throw new Error("sandbox token file is empty");
        return token;
      };
  // KOBE-27: /workspace ↔ S3 through the server (no storage credentials in the sandbox). The
  // restore starts now, in parallel with the wire and Pi; runs wait for it.
  const workspace =
    config.workspaceSyncIntervalMs > 0
      ? new WorkspaceSync({
          root: config.workspaceDir,
          client: new SyncClient({ serverUrl: config.serverUrl, readToken }),
          logger,
          intervalMs: config.workspaceSyncIntervalMs,
        })
      : undefined;
  // KOBE-82: the run's effective skills, fetched from the server (never from object storage) and
  // materialized read-only for the Pi uids. Emptied now: an earlier agent's skills are stale.
  const skills =
    config.skillsDir === undefined
      ? undefined
      : new SkillStore({
          root: config.skillsDir,
          identities: identities !== undefined,
          fetch: createSkillFetcher({ serverUrl: config.serverUrl, readToken }),
          log: logger,
        });
  await skills?.init();
  const agent = new Agent({
    config,
    ...(skills === undefined ? {} : { skills }),
    logger,
    readToken,
    ...(workspace === undefined ? {} : { workspace }),
    agentVersion,
    piVersion,
    home,
    identities,
    parentEnv: process.env,
    models,
    egress,
    toolsExtension: checked.toolsExtension,
    exec,
    onExit: (code) => process.exit(code),
  });
  process.on("exit", () => agent.killAll());
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => void agent.stop(SHUTDOWN_DEADLINE_MS, 0));
  }
  agent.start();
  workspace?.start();
}

/**
 * The tool executor (KOBE-167), when switched on (`KOBE_TOOL_EXECUTOR`, default on) and the image
 * has the kobe-exec extension (`KOBE_EXEC_EXTENSION`): every Pi's built-in tools then run in an
 * executor under its partner uid. Fails closed: asked for under Pi identities without the partner
 * groups (a pod spec from before KOBE-166), the agent does not start rather than quietly run the
 * tools in Pi; the extension is held to the same root-owned check as the others.
 */
async function toolExecutor(
  config: Config,
  identities: PiIdentities | undefined,
): Promise<AgentDeps["exec"]> {
  if (!config.toolExecutor) {
    logger.warn("KOBE_TOOL_EXECUTOR is off: Pi runs its tools in its own process and uid");
    return undefined;
  }
  if (config.execExtension === undefined) {
    // In Kobe's pods the server asked for it: an image that cannot provide it must not run quietly
    // without (skew between the server and the sandbox image).
    if (config.bootstrapTokenFile !== undefined) {
      throw new Error(
        "KOBE_TOOL_EXECUTOR is on but this image has no kobe-exec extension (KOBE_EXEC_EXTENSION): " +
          "refusing to run the tools in Pi (set KOBE_TOOL_EXECUTOR=false to allow it)",
      );
    }
    logger.warn("KOBE_EXEC_EXTENSION not set: Pi runs its tools in its own process and uid");
    return undefined;
  }
  if (identities !== undefined && !identities.paired) {
    throw new Error(
      "KOBE_TOOL_EXECUTOR is on but the pod gives the agent no partner (tool) uid groups " +
        "3000-3063: refusing to run the tools in Pi (set KOBE_TOOL_EXECUTOR=false to allow it)",
    );
  }
  const extension = await checkExtensionFile(config.execExtension, "kobe-exec");
  const executorEntry = fileURLToPath(new URL("./exec/executor/main.js", import.meta.url));
  await access(executorEntry, constants.R_OK).catch(() => {
    throw new Error(`tool executor program not found: ${executorEntry}`);
  });
  logger.info(
    { partnerUids: identities?.paired === true },
    "Pi's tools run in an executor under the partner uid",
  );
  return { extension, wiring: { executorEntry, nodeBin: process.execPath } };
}

/**
 * Pi identities (KOBE-71), when the pod asks for them (`KOBE_PI_RUNAS`): the helper must work,
 * the pod must give the agent one identity group per Pi process, and Pi's runtime directories
 * must not be on the workspace volume (the agent's guard against a swapped workspace parent
 * relies on that, workspace/volume.ts). Any failure stops the agent (fail closed).
 */
async function piIdentities(config: Config): Promise<PiIdentities | undefined> {
  if (config.piRunAs === undefined) {
    // Kobe's pods (bootstrap token) always ask for identities: never run them without.
    if (config.bootstrapTokenFile !== undefined) {
      throw new Error(
        "KOBE_PI_RUNAS is required in a Kobe sandbox pod (KOBE_BOOTSTRAP_TOKEN_FILE set)",
      );
    }
    logger.warn("KOBE_PI_RUNAS not set: Pi and its tools run as the agent's own uid");
    return undefined;
  }
  // The helper's start-up probe also proves a tool cannot ptrace or read the memory of its Pi
  // (it shares Pi's uid; kobe-policy and the policy socket live in Pi): refused otherwise.
  const identities = await loadPiIdentities(config.piRunAs, config.maxPiProcesses);
  await mkdir(config.piRuntimeDir, { recursive: true, mode: 0o700 });
  // The workspace guard (workspace/volume.ts) tells files apart by device: what the agent alone
  // may reach (Pi runtime dirs, the bootstrap token) must be on other filesystems than /workspace.
  const workspace = await stat(config.workspaceDir);
  const private_ = [config.piRuntimeDir];
  // Skills (KOBE-82) are the agent's too: Pi uids read them, only the agent may write.
  if (config.skillsDir !== undefined) {
    await mkdir(config.skillsDir, { recursive: true, mode: 0o700 });
    private_.push(config.skillsDir);
  }
  if (config.bootstrapTokenFile !== undefined)
    private_.push(path.dirname(config.bootstrapTokenFile));
  for (const dir of private_) {
    if ((await stat(dir)).dev === workspace.dev) {
      throw new Error(
        `${dir} must be on another filesystem than the workspace (${config.workspaceDir})`,
      );
    }
  }
  logger.info({ identities: identities.size }, "Pi processes run under their own uids");
  return identities;
}

/**
 * Model gateway wiring (KOBE-41): only with a model gateway URL (the pod spec sets it when the
 * sandbox may reach models) and a session to trade tokens with (Kobe's pods). The kobe-models
 * file gets the same root-owned check as kobe-policy; the keeper trades the first token now (on
 * the cold-start path, in parallel with the other startup work) and rotates it before expiry.
 */
async function modelWiring(
  config: ReturnType<typeof loadConfig>,
  session: SessionClient | undefined,
): Promise<ModelWiring | undefined> {
  if (config.modelGatewayUrl === undefined) return undefined;
  if (session === undefined) {
    logger.warn("KOBE_MODEL_GATEWAY_URL set without a bootstrap token: models stay off");
    return undefined;
  }
  const extension = await checkExtensionFile(config.modelsExtension, "kobe-models");
  const keeper = new ModelTokenKeeper({
    grant: () => session.modelGatewayGrant(),
    refreshMarginMs: session.refreshMarginMs,
    logger,
  });
  await keeper.start();
  return { gatewayUrl: config.modelGatewayUrl, extension, tokens: keeper };
}

/**
 * Egress for Pi's tools (KOBE-39): only with the egress proxy URL and a session to trade tokens
 * with (Kobe's pods). The BASH_ENV script gets the same root-owned check as the extensions: a
 * script the sandbox user could edit would run in every tool's shell.
 */
async function egressWiring(
  config: ReturnType<typeof loadConfig>,
  session: SessionClient | undefined,
): Promise<EgressWiring | undefined> {
  if (config.egressProxyUrl === undefined || session === undefined) return undefined;
  const envScript = await checkExtensionFile(config.egressEnvScript, "egress-env");
  const keeper = new ModelTokenKeeper({
    grant: () => session.egressProxyGrant(),
    refreshMarginMs: session.refreshMarginMs,
    logger,
  });
  await keeper.start();
  return { proxyUrl: config.egressProxyUrl, noProxy: config.noProxy, envScript, tokens: keeper };
}

main().catch((error: unknown) => {
  logger.fatal({ err: error instanceof Error ? error.message : String(error) }, "startup failed");
  process.exitCode = 1;
});
