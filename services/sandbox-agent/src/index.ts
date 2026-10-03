import { readFile } from "node:fs/promises";
import { Agent } from "./agent.js";
import { loadConfig } from "./config.js";
import { hardenProcess } from "./harden.js";
import { logger } from "./logger.js";
import { buildPiLaunch } from "./pi/pi-launch.js";
import { checkPolicyExtensionFile } from "./policy/extension-file.js";
import { SessionClient } from "./session/exchange.js";
import { piVersion as readPiVersion, readAgentVersion } from "./version.js";

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
  const piEnv = buildPiLaunch({
    sessionFile: "-",
    home,
    agentDir: checked.piAgentDir,
    policyExtension: checked.policyExtension,
    parentEnv: process.env,
  }).env;
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
  const [agentVersion, piVersion, grant] = await Promise.all([
    readAgentVersion(new URL("../package.json", import.meta.url)),
    readPiVersion(loaded.piBin, piEnv),
    session?.grant(),
  ]);
  const config = grant ? { ...checked, sandboxId: grant.sandboxId } : checked;
  logger.info(
    { server: config.connectUrl, sandbox_id: config.sandboxId, agentVersion, piVersion },
    "sandbox-agent starting",
  );

  const agent = new Agent({
    config,
    logger,
    readToken: session
      ? () => session.wireToken()
      : async () => {
          const token = (await readFile(config.tokenFile, "utf8")).trim();
          if (token === "") throw new Error("sandbox token file is empty");
          return token;
        },
    agentVersion,
    piVersion,
    home,
    parentEnv: process.env,
    onExit: (code) => process.exit(code),
  });
  process.on("exit", () => agent.killAll());
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => void agent.stop(SHUTDOWN_DEADLINE_MS, 0));
  }
  agent.start();
}

main().catch((error: unknown) => {
  logger.fatal({ err: error instanceof Error ? error.message : String(error) }, "startup failed");
  process.exitCode = 1;
});
