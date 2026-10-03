import { parseArgs } from "node:util";
import { exitSoon, joinAsReplica } from "./replica.js";

// Operator tool (KOBE-25), run inside a server pod (its ServiceAccount and env):
//   node dist/cli/lifecycle.js hibernate --team-id <uuid> --user-id <uuid>
//   node dist/cli/lifecycle.js wake --team-id <uuid> --user-id <uuid>
// `hibernate` suspends the (user, team) sandbox now unless it is busy (an active or queued run, a
// command in flight) — the idle time is skipped, nothing else. `wake` resumes it through the
// isolation gate. Both take the same path, row lock and audit as the server. Used by e2e/run.sh.
const USAGE = "usage: lifecycle.js hibernate|wake --team-id <uuid> --user-id <uuid>";

async function main(): Promise<number> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { "team-id": { type: "string" }, "user-id": { type: "string" } },
  });
  const action = positionals[0];
  const teamId = values["team-id"];
  const userId = values["user-id"];
  if ((action !== "hibernate" && action !== "wake") || !teamId || !userId) {
    console.error(USAGE);
    return 2;
  }
  const replica = joinAsReplica(process.env);
  if (typeof replica === "string") {
    console.error(replica);
    return 2;
  }
  try {
    const target = { teamId, userId };
    if (action === "hibernate") {
      const done = await replica.lifecycle.hibernate(target, { force: true });
      console.log(JSON.stringify({ hibernated: done }));
      return done ? 0 : 1;
    }
    await replica.lifecycle.waker.wake(target);
    console.log(JSON.stringify({ woken: true }));
    return 0;
  } finally {
    await replica.close();
  }
}

main().then(exitSoon, (err: unknown) => {
  console.error(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  exitSoon(1);
});
