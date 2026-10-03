import { parseArgs } from "node:util";
import { and, eq, sql, threads, withTeam, type KobeDb } from "@kobe/db";
import { createKubeClient, type KubeClient } from "../sandbox/kube.js";
import {
  runColdStartTrials,
  type ColdStartReport,
  type ColdStartSteps,
} from "../sandbox-lifecycle/cold-start.js";
import type { SandboxRouter, SandboxTarget } from "../sandbox-wire/types.js";
import { exitSoon, joinAsReplica } from "./replica.js";

// Cold-start harness (KOBE-25), run inside a server pod (its ServiceAccount and env):
//   node dist/cli/cold-start.js --team-id <uuid> --user-id <uuid> [--trials 20] [--probe pi]
//     [--spacing-ms 0] [--label name] [--p95-max-ms MS] [--p50-max-ms MS]
// Joins the install as one more router replica (no sandbox listener), hibernates the (user, team)
// sandbox, waits until it is fully down (Suspended, no pod, no connection) plus `--spacing-ms`,
// then times a command that has to wake it — through the same router → waker → provider path the
// server uses. Prints one JSON line per trial and a summary; exits 1 when a given percentile
// budget is exceeded, 2 when the harness fails.
//
// Gate 1 is hibernated → FIRST TOKEN. Probes measure what exists today:
//   connected — the woken sandbox's agent holds a wire connection again
//   pi        — Pi answers `get_state` on a thread (agent connected + Pi spawned): "Pi ready"
// A `first-token` probe (create a run, router.startRun, wait for its first `text.delta` in
// run_events) needs a model (KOBE-30/40/41): add it to PROBES; nothing else changes.
const USAGE =
  "usage: cold-start.js --team-id <uuid> --user-id <uuid> [--trials N] [--probe pi|connected] " +
  "[--spacing-ms MS] [--label NAME] [--p95-max-ms MS] [--p50-max-ms MS]";
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

async function createHarnessThread(db: KobeDb, target: SandboxTarget): Promise<string> {
  return withTeam(db, target.teamId, async (tx) => {
    const [row] = await tx
      .insert(threads)
      .values({ teamId: target.teamId, ownerUserId: target.userId, title: "cold-start harness" })
      .returning({ id: threads.id });
    if (!row) throw new Error("could not create the harness thread");
    return row.id;
  });
}

async function deleteHarnessThread(db: KobeDb, target: SandboxTarget, id: string): Promise<void> {
  await withTeam(db, target.teamId, (tx) =>
    tx.delete(threads).where(and(eq(threads.teamId, target.teamId), eq(threads.id, id))),
  );
}

interface Wiring {
  readonly db: KobeDb;
  readonly router: SandboxRouter;
  readonly target: SandboxTarget;
  readonly namespace: string;
  readonly threadId: string;
  readonly spacingMs: number;
  hibernate(): Promise<boolean>;
}

/** The sandbox as Kubernetes has it, read directly (never through ensureSandbox: no writes). */
async function observe(kube: KubeClient, w: Wiring) {
  const claim = await kube.get({
    apiVersion: "extensions.agents.x-k8s.io/v1beta1",
    kind: "SandboxClaim",
    name: `u-${w.target.userId}`,
    namespace: w.namespace,
  });
  const name = (claim?.status as { sandbox?: { name?: string } } | undefined)?.sandbox?.name;
  if (!name) return {};
  const ref = { name, namespace: w.namespace };
  const [sandbox, pod] = await Promise.all([
    kube.get({ apiVersion: "agents.x-k8s.io/v1beta1", kind: "Sandbox", ...ref }),
    kube.get({ apiVersion: "v1", kind: "Pod", ...ref }),
  ]);
  return {
    mode: (sandbox?.spec as { operatingMode?: string } | undefined)?.operatingMode,
    pod,
  };
}

/** The measured action of a probe: resolves when its end point is reached. */
type Probe = (w: Wiring, t0: number) => Promise<void>;

const getState = (w: Wiring) =>
  w.router.piCommand(
    w.target,
    { threadId: w.threadId, command: { id: "cold-start", type: "get_state" } },
    { timeoutMs: PROBE_TIMEOUT_MS },
  );

const PROBES: Record<string, Probe> = {
  async pi(w) {
    const outcome = await getState(w);
    if (!outcome.ok)
      throw new Error(`probe failed: ${outcome.error.code} ${outcome.error.message}`);
  },
  async connected(w, t0) {
    void getState(w); // wakes the sandbox; only the connection is timed
    while ((await connectedAt(w.db, w.target)) === undefined) {
      if (performance.now() - t0 > PROBE_TIMEOUT_MS) throw new Error("never connected");
      await sleep(50);
    }
  },
};

function steps(w: Wiring, probeName: string, label: string): ColdStartSteps {
  const kube = createKubeClient();
  const probe = PROBES[probeName] as Probe;
  return {
    async hibernate() {
      if (!(await w.hibernate())) {
        throw new Error("the sandbox could not be hibernated (busy, or no sandbox row)");
      }
    },
    async waitHibernated() {
      const deadline = Date.now() + HIBERNATED_TIMEOUT_MS;
      for (;;) {
        const { mode, pod } = await observe(kube, w);
        if (mode === "Suspended" && !pod && (await connectedAt(w.db, w.target)) === undefined) {
          break;
        }
        if (Date.now() > deadline) throw new Error("the sandbox did not go fully down");
        await sleep(250);
      }
      if (w.spacingMs > 0) await sleep(w.spacingMs);
    },
    async probe() {
      const t0db = await dbNow(w.db);
      const t0 = performance.now();
      await probe(w, t0);
      const totalMs = Math.round(performance.now() - t0);
      const connected = await connectedAt(w.db, w.target);
      const { pod } = await observe(kube, w);
      // Pod timestamps have 1 s resolution (Kubernetes); good enough to see where time goes.
      const at = (iso: unknown) =>
        typeof iso === "string" ? Math.max(0, Date.parse(iso) - t0db) : undefined;
      const status = pod?.status as
        { containerStatuses?: { state?: { running?: { startedAt?: string } } }[] } | undefined;
      return {
        totalMs,
        milestones: {
          podCreated: at(pod?.metadata.creationTimestamp),
          containerStarted: at(status?.containerStatuses?.[0]?.state?.running?.startedAt),
          connected: connected === undefined ? undefined : Math.max(0, connected - t0db),
          ...(probeName === "pi" ? { piReady: totalMs } : {}),
        },
      };
    },
    onTrial(trial) {
      console.log(
        JSON.stringify({ label, trial: trial.index + 1, ms: trial.totalMs, ...trial.milestones }),
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
      "spacing-ms": { type: "string", default: "0" },
      label: { type: "string", default: "back-to-back" },
      "p95-max-ms": { type: "string" },
      "p50-max-ms": { type: "string" },
    },
  });
  const teamId = values["team-id"];
  const userId = values["user-id"];
  const trials = Number(values.trials);
  const probe = values.probe ?? "pi";
  const spacingMs = Number(values["spacing-ms"]);
  const label = values.label ?? "back-to-back";
  if (
    !teamId ||
    !userId ||
    !Number.isInteger(trials) ||
    trials < 1 ||
    !(probe in PROBES) ||
    !Number.isInteger(spacingMs) ||
    spacingMs < 0
  ) {
    console.error(USAGE);
    return 2;
  }
  const replica = joinAsReplica(process.env);
  if (typeof replica === "string") {
    console.error(replica);
    return 2;
  }
  const { database, lifecycle, wire } = replica;
  const target = { teamId, userId };
  let report: ColdStartReport;
  let threadId: string | undefined;
  try {
    const [team] = await database.db
      .execute<{ id: string; slug: string }>(sql`SELECT id, slug FROM teams WHERE id = ${teamId}`)
      .then((r) => r.rows);
    if (!team) throw new Error("no such team");
    // Awake and connected before the first trial (a first-ever sandbox is not a cold start).
    await lifecycle.waker.wake(target);
    threadId = await createHarnessThread(database.db, target);
    const warm = await wire.router.piCommand(
      target,
      { threadId, command: { id: "warm-up", type: "get_state" } },
      { timeoutMs: PROBE_TIMEOUT_MS * 2 },
    );
    if (!warm.ok) throw new Error(`warm-up failed: ${warm.error.code} ${warm.error.message}`);
    const wiring: Wiring = {
      db: database.db,
      router: wire.router,
      target,
      namespace: `kobe-team-${team.slug}`,
      threadId,
      spacingMs,
      hibernate: () => lifecycle.hibernate(target, { force: true }),
    };
    report = await runColdStartTrials(probe, trials, steps(wiring, probe, label));
  } catch (err) {
    console.error(`cold-start harness failed: ${err instanceof Error ? err.message : String(err)}`);
    if (threadId) await deleteHarnessThread(database.db, target, threadId).catch(() => {});
    await replica.close();
    return 2;
  }
  await deleteHarnessThread(database.db, target, threadId).catch(() => {});
  await replica.close();
  const p95Max = values["p95-max-ms"] ? Number(values["p95-max-ms"]) : undefined;
  const p50Max = values["p50-max-ms"] ? Number(values["p50-max-ms"]) : undefined;
  const pass =
    (p95Max === undefined || report.total.p95 <= p95Max) &&
    (p50Max === undefined || report.total.p50 <= p50Max);
  console.log(
    JSON.stringify({
      summary: true,
      label,
      probe: report.probe,
      spacingMs,
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
