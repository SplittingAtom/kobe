import { parseArgs } from "node:util";
import { createIsolationGate } from "../isolation/gate.js";
import { listRuntimeClasses } from "../isolation/kubernetes.js";
import { createSandboxRuntime } from "../sandbox/runtime.js";

// Operator tool, run inside a server pod (its ServiceAccount and env):
//   node dist/cli/sandbox.js ensure --team-id <uuid> --team-slug <slug> --user-id <uuid>
// Ensures the team namespace and the (user, team) sandbox through the same code path as the
// server, isolation gate included, and prints the sandbox handle as JSON. Used by e2e/run.sh.
const USAGE = "usage: sandbox.js ensure --team-id <uuid> --team-slug <slug> --user-id <uuid>";

async function main(): Promise<number> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      "team-id": { type: "string" },
      "team-slug": { type: "string" },
      "user-id": { type: "string" },
    },
  });
  const teamId = values["team-id"];
  const slug = values["team-slug"];
  const userId = values["user-id"];
  if (positionals[0] !== "ensure" || !teamId || !slug || !userId) {
    console.error(USAGE);
    return 2;
  }
  const isolation = createIsolationGate({
    runtimeClassName: process.env.KOBE_RUNTIME_CLASS?.trim() || undefined,
    listRuntimeClasses,
  });
  const runtime = createSandboxRuntime(process.env, isolation);
  if (!runtime) {
    console.error("KOBE_SANDBOX_CONFIG is not set: sandboxes are disabled");
    return 1;
  }
  const handle = await runtime.provider.ensureSandbox({ id: teamId, slug }, userId);
  console.log(JSON.stringify(handle));
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
    process.exitCode = 1;
  },
);
