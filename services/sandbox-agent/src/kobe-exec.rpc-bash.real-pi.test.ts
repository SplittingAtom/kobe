import path from "node:path";
import { fileURLToPath } from "node:url";
import { startLocalGateway, type LocalGateway } from "@kobe/model-gateway/testing";
import { afterEach, describe, expect, it } from "vitest";
import { PiRpc } from "./testing/real-pi-rpc.js";
import {
  EXECUTOR_BUILT,
  EXECUTOR_ENTRY,
  PI_AVAILABLE,
  PI_BIN,
  REAL_EXEC_EXTENSION,
  REAL_POLICY_EXTENSION,
} from "./testing/real-pi.js";

/**
 * Pi's RPC `bash` command (and a user's `!` command) run a shell in Pi through
 * `createLocalBashOperations`, not through the bash *tool*. The server never sends it (it is not in
 * the agent's `pi.command` allow-list), but kobe-exec closes it anyway with a `user_bash` handler
 * (KOBE-167): with the extension loaded the command runs in the executor too. Real Pi 1.0.0.
 */
const PACKAGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODELS_EXTENSION = path.join(
  PACKAGE,
  process.env.CI === undefined ? "src/kobe-models/index.ts" : "dist/kobe-models/index.js",
);

let pi: PiRpc | undefined;
let gateway: LocalGateway | undefined;
afterEach(async () => {
  await pi?.close();
  await gateway?.close();
  pi = gateway = undefined;
});

async function start(withExec: boolean): Promise<PiRpc> {
  gateway = await startLocalGateway({ enabledModels: [] });
  pi = await PiRpc.start(
    {
      piBin: PI_BIN,
      modelsExtension: MODELS_EXTENSION,
      policyExtension: REAL_POLICY_EXTENSION,
      gatewayUrl: gateway.url,
      ...(withExec
        ? { exec: { extension: REAL_EXEC_EXTENSION, executorEntry: EXECUTOR_ENTRY } }
        : {}),
    },
    gateway.mintToken(),
  );
  return pi;
}

const outputOf = (response: Record<string, unknown>) =>
  (response.data as { output: string; exitCode: number }).output;

describe.skipIf(!PI_AVAILABLE || !EXECUTOR_BUILT)("the RPC bash command with kobe-exec", () => {
  it("runs in the executor, not in Pi", async () => {
    const rpc = await start(true);
    const response = await rpc.command({ type: "bash", command: "ps -o command= -p $PPID" });
    expect(response).toMatchObject({ success: true });
    expect(outputOf(response)).toContain("exec/executor/main.js");
  }, 60_000);

  it("control: without the extension it runs in Pi's own process", async () => {
    const rpc = await start(false);
    const response = await rpc.command({ type: "bash", command: "ps -o command= -p $PPID" });
    expect(outputOf(response)).not.toContain("exec/executor/main.js");
  }, 60_000);
});
