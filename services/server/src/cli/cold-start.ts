import { parseArgs } from "node:util";
import { sql, threads, withTeam, type KobeDb } from "@kobe/db";
import { createKubeClient } from "../sandbox/kube.js";
import type { SandboxProvider } from "../sandbox/provider.js";
import {
  runColdStartTrials,
  type ColdStartReport,
  type ColdStartSteps,
} from "../sandbox-lifecycle/cold-start.js";
import type { SandboxRouter, SandboxTarget } from "../sandbox-wire/types.js";
import { exitSoon, joinAsReplica } from "./replica.js";

// Cold-start harness (KOBE-25, Gate 1), run inside a server pod (its ServiceAccount and env):
//   node dist/cli/cold-start.js --team-id <uuid> --user-id <uuid> [--trials 20] [--probe pi]
//     [--p95-max-ms 8000] [--p50-max-ms 3000]
// Joins the install as one more router replica (no sandbox listener), hibernates the (user, team)
// sandbox, waits until its pod is gone, then times a command that has to wake it — through the
// same router → waker → provider path the server uses. Prints one JSON line per trial and a
// summary line; exits 1 when a given percentile budget is exceeded, 2 when the harness fails.
const USAGE =
  "usage: cold-start.js --team-id <uuid> --user-id <uuid> [--trials N] [--probe pi|connected] " +
  "[--p95-max-ms MS] [--p50-max-ms MS]";
const PROBES = ["pi", "connected"] as const;
type ProbeName = (typeof PROBES)[number];
/** A woken sandbox must answer within this (pod start + agent + Pi). */
const PROBE_TIMEOUT_MS = 120_000;
const HIBERNATED_TIMEOUT_MS = 120_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function dbNow(db: KobeDb): Promise<number> {
  const res = await db.execute<{ now: Date }>(sql`SELECT clock_timestamp() AS now`);
  return new Date(res.rows[0]?.now ?? Date.now()).getTime();
}

/** When the sandbox's current wire connection was registered (DB clock), if open. */
async function connectedAt(db: KobeDb, target: SandboxTarget): Promise<number | undefined> {
  const res = await withTeam(db, target.teamId, (tx) =>
    tx.execute<{ connected_at: Date }>(sql`
      SELECT connected_at FROM sandbox_connections
       WHERE team_id = ${target.teamId} AND user_id = ${target.userId} AND closed_at IS NULL`),
  );
  const at = res.rows[0]?.connected_at;
  return at ? new Date(at).getTime() : undefined;
}

async function harnessThread(db: KobeDb, target: SandboxTarget): Promise<string> {
  return withTeam(db, target.teamId, async (tx) => {
    const [row] = await tx
      .insert(threads)
      .values({ teamId: target.teamId, ownerUserId: target.userId, title: "cold-start harness" })
      .returning({ id: threads.id });
    if (!row) throw new Error("could not create the harness thread");
    return row.id;
  });
}

interface Wiring {
  readonly db: KobeDb;
  readonly provider: SandboxProvider;
  readonly router: SandboxRouter;
  readonly target: SandboxTarget;
  readonly team: { id: string; slug: string };
  readonly threadId: string;
  hibernate(): Promise<boolean>;
}

function steps(w: Wiring, probe: ProbeName): ColdStartSteps {
  const kube = createKubeClient();
  return {
    async hibernate() {
      if (!(await w.hibernate())) {
        throw new Error("the sandbox could not be hibernated (busy, or no sandbox row)");
      }
    },
    async waitHibernated() {
      const handle = await w.provider.ensureSandbox(w.team, w.target.userId);
      const deadline = Date.now() + HIBERNATED_TIMEOUT_MS;
      for (;;) {
        const pod = await kube.get({
          apiVersion: "v1",
          kind: "Pod",
          name: handle.sandboxName,
          namespace: handle.namespace,
        });
        if (!pod && (await connectedAt(w.db, w.target)) === undefined) return;
        if (Date.now() > deadline) throw new Error("the sandbox pod did not go away");
        await sleep(250);
      }
    },
    async probe() {
      const t0db = await dbNow(w.db);
      const t0 = performance.now();
      let totalMs: number;
      if (probe === "pi") {
        const outcome = await w.router.piCommand(
          w.target,
          { threadId: w.threadId, command: { id: "cold-start", type: "get_state" } },
          { timeoutMs: PROBE_TIMEOUT_MS },
        );
        totalMs = performance.now() - t0;
        if (!outcome.ok)
          throw new Error(`probe failed: ${outcome.error.code} ${outcome.error.message}`);
      } else {
        // The command wakes the sandbox; we time the connection only.
        void w.router.piCommand(
          w.target,
          { threadId: w.threadId, command: { id: "cold-start", type: "get_state" } },
          { timeoutMs: PROBE_TIMEOUT_MS },
        );
        for (;;) {
          if ((await connectedAt(w.db, w.target)) !== undefined) break;
          if (performance.now() - t0 > PROBE_TIMEOUT_MS) throw new Error("never connected");
          await sleep(50);
        }
        totalMs = performance.now() - t0;
      }
      const connected = await connectedAt(w.db, w.target);
      const handle = await w.provider.ensureSandbox(w.team, w.target.userId);
      const pod = handle.podName
        ? await kube.get({
            apiVersion: "v1",
            kind: "Pod",
            name: handle.podName,
            namespace: handle.namespace,
          })
        : undefined;
      // Pod timestamps have 1 s resolution (Kubernetes); good enough to see where time goes.
      const at = (iso: unknown) =>
        typeof iso === "string" ? Math.max(0, Date.parse(iso) - t0db) : undefined;
      const status = pod?.status as
        { containerStatuses?: { state?: { running?: { startedAt?: string } } }[] } | undefined;
      return {
        totalMs: Math.round(totalMs),
        milestones: {
          podCreated: at(pod?.metadata.creationTimestamp),
          containerStarted: at(status?.containerStatuses?.[0]?.state?.running?.startedAt),
          connected: connected === undefined ? undefined : Math.max(0, connected - t0db),
          ...(probe === "pi" ? { piReady: Math.round(totalMs) } : {}),
        },
      };
    },
    onTrial(trial) {
      console.log(
        JSON.stringify({ trial: trial.index + 1, ms: trial.totalMs, ...trial.milestones }),
      );
    },
  };
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      "team-id": { type: "string" },
      "user-id": { type: "string" },
      trials: { type: "string", default: "20" },
      probe: { type: "string", default: "pi" },
      "p95-max-ms": { type: "string" },
      "p50-max-ms": { type: "string" },
    },
  });
  const teamId = values["team-id"];
  const userId = values["user-id"];
  const trials = Number(values.trials);
  const probe = values.probe as ProbeName;
  if (!teamId || !userId || !Number.isInteger(trials) || trials < 1 || !PROBES.includes(probe)) {
    console.error(USAGE);
    return 2;
  }
  const replica = joinAsReplica(process.env);
  if (typeof replica === "string") {
    console.error(replica);
    return 2;
  }
  const { database, runtime, lifecycle, wire } = replica;
  const target = { teamId, userId };
  let report: ColdStartReport;
  try {
    const [team] = await database.db
      .execute<{ id: string; slug: string }>(sql`SELECT id, slug FROM teams WHERE id = ${teamId}`)
      .then((r) => r.rows);
    if (!team) throw new Error("no such team");
    // Awake and connected before the first trial (a first-ever sandbox is not a cold start).
    await lifecycle.waker.wake(target);
    const threadId = await harnessThread(database.db, target);
    const warm = await wire.router.piCommand(
      target,
      { threadId, command: { id: "warm-up", type: "get_state" } },
      { timeoutMs: PROBE_TIMEOUT_MS * 2 },
    );
    if (!warm.ok) throw new Error(`warm-up failed: ${warm.error.code} ${warm.error.message}`);
    report = await runColdStartTrials(
      probe,
      trials,
      steps(
        {
          db: database.db,
          provider: runtime.provider,
          router: wire.router,
          target,
          team,
          threadId,
          hibernate: () => lifecycle.hibernate(target, { force: true }),
        },
        probe,
      ),
    );
  } catch (err) {
    console.error(`cold-start harness failed: ${err instanceof Error ? err.message : String(err)}`);
    await replica.close();
    return 2;
  }
  await replica.close();
  const p95Max = values["p95-max-ms"] ? Number(values["p95-max-ms"]) : undefined;
  const p50Max = values["p50-max-ms"] ? Number(values["p50-max-ms"]) : undefined;
  const pass =
    (p95Max === undefined || report.total.p95 <= p95Max) &&
    (p50Max === undefined || report.total.p50 <= p50Max);
  console.log(
    JSON.stringify({
      summary: true,
      probe: report.probe,
      trials: report.total.n,
      p50: Math.round(report.total.p50),
      p95: Math.round(report.total.p95),
      min: Math.round(report.total.min),
      max: Math.round(report.total.max),
      milestones: Object.fromEntries(
        Object.entries(report.milestones).map(([k, v]) => [
          k,
          { p50: Math.round(v.p50), p95: Math.round(v.p95), max: Math.round(v.max) },
        ]),
      ),
      budget: { p50: p50Max ?? null, p95: p95Max ?? null },
      pass,
    }),
  );
  return pass ? 0 : 1;
}

main().then(exitSoon, (err: unknown) => {
  console.error(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  exitSoon(2);
});
