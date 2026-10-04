import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { Agent } from "./agent.js";
import { loadConfig } from "./config.js";
import { hardenProcess } from "./harden.js";
import { logger } from "./logger.js";
import { sweepRuntimeDir } from "./models/runtime-dir.js";
import { ModelTokenKeeper } from "./models/token-keeper.js";
import type { EgressWiring } from "./egress/egress-wiring.js";
import type { ModelWiring } from "./models/types.js";
import { buildPiLaunch } from "./pi/pi-launch.js";
import { checkExtensionFile, checkPolicyExtensionFile } from "./policy/extension-file.js";
import { SessionClient } from "./session/exchange.js";
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
  };
  const home = process.env.HOME ?? "/home/kobe";
  // Pi's private runtime directories live here: leftovers of an earlier agent (a pod restart)
  // are swept first, so no stale token outlives its process; the version probe gets its own dir.
  const swept = await sweepRuntimeDir(checked.piRuntimeDir);
  if (swept > 0) logger.warn({ removed: swept }, "removed stale Pi runtime directories");
  const probeDir = path.join(checked.piRuntimeDir, "version-probe");
  await mkdir(probeDir, { recursive: true, mode: 0o700 });
  const piEnv = {
    ...buildPiLaunch({
      sessionFile: "-",
      home,
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
  const agent = new Agent({
    config,
    logger,
    readToken,
    ...(workspace === undefined ? {} : { workspace }),
    agentVersion,
    piVersion,
    home,
    parentEnv: process.env,
    models,
    egress,
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
