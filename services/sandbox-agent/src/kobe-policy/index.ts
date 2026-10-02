import { fileURLToPath } from "node:url";
import type { PolicyChecker } from "./handler.js";
import { connectPolicy, registerKobePolicy, type ExtensionApiLike } from "./extension.js";

/**
 * kobe-policy: the Pi 1.0.x extension that asks the Kobe server about every tool call (spec D13,
 * D29; KOBE-36). kobe-sandbox-agent loads it with `--extension <root-owned path>`, last, into every
 * `pi --mode rpc` it starts, with the policy channel on fd 3 (`KOBE_POLICY_FD`).
 *
 * Self-contained by design: imports only node builtins and files in this directory, because the
 * image ships it on its own (root-owned, read-only, `/opt/kobe/pi-extensions/kobe-policy`).
 *
 * The channel is opened once per Pi process (module scope). If Pi re-evaluates the module (a
 * reload), the fd variable is already gone and the new instance blocks every call — fail closed.
 */
let checker: Promise<PolicyChecker> | undefined;

export default async function kobePolicy(pi: ExtensionApiLike): Promise<void> {
  checker ??= connectPolicy({
    env: process.env,
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    ownPath: fileURLToPath(import.meta.url),
    // stderr only: stdout is Pi's RPC stream.
    warn: (message) => process.stderr.write(`${message}\n`),
  });
  await registerKobePolicy(pi, checker);
}
