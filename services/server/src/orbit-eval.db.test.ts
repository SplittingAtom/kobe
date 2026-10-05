import { randomUUID } from "node:crypto";
import { loadGatewayPrincipal } from "@kobe/db";
import { verifySessionToken } from "@kobe/session-token";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { EvalRunner } from "./agents/eval/service.js";
import {
  createEval,
  finishEval,
  getEval,
  markRunning,
  readEvalSettings,
} from "./agents/eval/store.js";
import type { SandboxSettings } from "./sandbox/config.js";
import type { KubeObject } from "./sandbox/manifests.js";
import { createFakeKube, type FakeKube } from "./testing/fake-kube.js";
import { openHarness, type Harness } from "./testing/harness.js";
import type { TestBrowser } from "./testing/browser.js";
import { KEYS, SETTINGS, gateFor, seedCluster } from "./testing/sandbox-fixtures.js";

/**
 * The pre-publish eval gate (KOBE-93) end to end on a fake cluster: the Job's result is
 * simulated (what the eval image prints), everything else is real: settings, the Publish route,
 * the Job manifest, the gateway token, the verdict, the publish that follows a pass, retries.
 */
const ANY = { "if-match": "*" };
const finance = randomUUID();
const sandbox: SandboxSettings = {
  ...SETTINGS,
  modelGatewayAccess: true,
  orbitEval: {
    image: "ghcr.io/splittingatom/kobe-orbit-eval:0.1.0",
    deadlineSeconds: 600,
    resources: { requests: { cpu: "250m", memory: "512Mi" }, limits: { cpu: "1", memory: "2Gi" } },
  },
};

let h: Harness;
let kube: FakeKube;
let admin: TestBrowser;
let builder: TestBrowser;
let member: TestBrowser;
let adminId: string;
let builderId: string;
/** What the simulated eval Job does when it is created: its log and how it ends. */
let jobResult: { log: string; outcome: "Complete" | "Failed"; reason?: string } | "hang";
let gateOpen = true;
let runner: EvalRunner | undefined;

const report = (over: Record<string, unknown> = {}) =>
  `ok: 5 scenarios\n${JSON.stringify(
    {
      schema_version: 1,
      attack_success_rate: 0,
      attempts: 5,
      attack_successes: 0,
      errors: 0,
      pack: { id: "default", version: "1" },
      ...over,
    },
    null,
    2,
  )}\n`;
const clean = () => ({ log: report(), outcome: "Complete" as const });
const attacked = () => ({
  log: report({ attack_success_rate: 0.6, attack_successes: 3 }),
  outcome: "Complete" as const,
});

/** The cluster as the Job controller would leave it after the server creates the Job. */
function finishJob(fake: FakeKube, object: KubeObject): void {
  {
    if (object.kind !== "Job" || jobResult === "hang") return;
    const ns = object.metadata.namespace as string;
    const evalId = object.metadata.labels?.["kobe.splittingatom.io/orbit-eval"] as string;
    const podName = `${object.metadata.name}-x7k2p`;
    fake.seed({
      apiVersion: "v1",
      kind: "Pod",
      metadata: {
        name: podName,
        namespace: ns,
        labels: { "kobe.splittingatom.io/orbit-eval": evalId },
      },
    });
    fake.podLogs.set(`${ns}/${podName}`, jobResult.log);
    fake.seed({
      ...object,
      status: {
        conditions: [
          {
            type: jobResult.outcome,
            status: "True",
            ...(jobResult.reason ? { reason: jobResult.reason } : {}),
          },
        ],
      },
    });
  }
}

const simulateJobController = (fake: FakeKube): void => {
  fake.afterWrite = (object) => finishJob(fake, object);
};

beforeAll(async () => {
  kube = createFakeKube();
  seedCluster(kube);
  simulateJobController(kube);
  const isolation = gateFor(kube);
  h = await openHarness({ agents: { publishRate: { windowMs: 60_000, max: 10_000 } } }, (deps) => {
    runner = new EvalRunner({
      db: deps.database.db,
      kube,
      provider: { ensureTeam: async () => "kobe-team-finance" },
      isolation: {
        require: () =>
          gateOpen
            ? isolation.require()
            : isolation.require().then(() => {
                throw new Error("no isolation");
              }),
      },
      settings: sandbox,
      sessionKeys: KEYS,
      pollMs: 1,
    });
    return { evals: runner };
  });
  adminId = await h.createUser("alice@eval.test");
  builderId = await h.createUser("bob@eval.test");
  const memberId = await h.createUser("carol@eval.test");
  await h.admin.query(`INSERT INTO teams (id, slug, name) VALUES ($1, 'finance', 'Finance')`, [
    finance,
  ]);
  for (const [id, role] of [
    [adminId, "team_admin"],
    [builderId, "builder"],
    [memberId, "member"],
  ] as const) {
    await h.admin.query(`INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, $3)`, [
      finance,
      id,
      role,
    ]);
  }
  await h.admin.query(
    `INSERT INTO model_providers (id, kind, name, api_key_enc, created_by)
     VALUES ('anthropic', 'anthropic', 'anthropic', 'v2.test.sealed-provider-key', $1)`,
    [adminId],
  );
  await h.admin.query(
    `INSERT INTO model_catalog (alias, provider_id, model, created_by) VALUES ('smart', 'anthropic', 'claude-smart', $1)`,
    [adminId],
  );
  await h.admin.query(
    `INSERT INTO team_models (team_id, alias, is_default, enabled_by) VALUES ($1, 'smart', true, $2)`,
    [finance, adminId],
  );
  for (const [who, name] of [
    ["alice", "admin"],
    ["bob", "builder"],
    ["carol", "member"],
  ] as const) {
    const b = await h.signIn(`${who}@eval.test`);
    expect((await b.put("/v1/me/teams/active", { teamId: finance })).status).toBe(200);
    b.team = finance;
    if (name === "admin") admin = b;
    else if (name === "builder") builder = b;
    else member = b;
  }
});

afterAll(async () => {
  await h?.close();
});

beforeEach(async () => {
  jobResult = clean();
  gateOpen = true;
  await h.admin.query(`DELETE FROM team_eval_settings`);
});

const gateOn = async (maxAttackSuccessRate?: number) => {
  const res = await admin.put("/v1/team/eval-settings", {
    enabled: true,
    ...(maxAttackSuccessRate === undefined ? {} : { maxAttackSuccessRate }),
  });
  expect(res.status, JSON.stringify(res.json)).toBe(200);
};

async function draft(scope: "team" | "personal" = "team"): Promise<string> {
  const created = await builder.post("/v1/agents", {
    scope,
    frontmatter: { name: `Gated ${randomUUID().slice(0, 6)}` },
    prompt: "You are careful.",
  });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  return created.json.agent.id as string;
}

const publish = (id: string) => builder.request("POST", `/v1/agents/${id}/publish`, {}, ANY);
const evals = async (id: string) => (await builder.get(`/v1/agents/${id}/evals`)).json;
const settled = async () => {
  await h.deps.background.idle();
};
const currentVersion = async (id: string) =>
  (
    await h.admin.query<{ current_version: number | null }>(
      `SELECT current_version FROM team_agents WHERE id = $1`,
      [id],
    )
  ).rows[0]?.current_version;

describe("team eval settings", () => {
  it("is off by default and a team admin turns it on, with a threshold, audited", async () => {
    expect((await member.get("/v1/team/eval-settings")).json).toEqual({
      enabled: false,
      maxAttackSuccessRate: 0.2,
    });
    await gateOn(0.4);
    expect((await member.get("/v1/team/eval-settings")).json).toEqual({
      enabled: true,
      maxAttackSuccessRate: 0.4,
    });
    const audit = await h.admin.query(
      `SELECT target FROM audit_log WHERE action = 'agent.eval.settings_changed' AND team_id = $1`,
      [finance],
    );
    expect(audit.rows.at(-1)?.target).toEqual({ enabled: true, maxAttackSuccessRate: 0.4 });
  });

  it("is for team admins only, and validates its input", async () => {
    expect((await builder.put("/v1/team/eval-settings", { enabled: true })).status).toBe(403);
    expect((await admin.put("/v1/team/eval-settings", { maxAttackSuccessRate: 2 })).status).toBe(
      400,
    );
    expect((await admin.put("/v1/team/eval-settings", {})).status).toBe(400);
  });
});

describe("Publish with the gate on (KOBE-93)", () => {
  it("publishes at once when the gate is off", async () => {
    const id = await draft();
    expect((await publish(id)).status).toBe(201);
    expect(kube.all("Job")).toHaveLength(0);
  });

  it("starts an eval and publishes when it passes: score on the version, Job as strict as a sandbox", async () => {
    await gateOn(0.2);
    const id = await draft();
    const res = await publish(id);
    expect(res.status, JSON.stringify(res.json)).toBe(202);
    expect(res.json.eval.status).toBe("pending");
    expect(await currentVersion(id)).toBeNull();
    await settled();

    const { evals: list, active } = await evals(id);
    expect(active).toBeNull();
    expect(list[0]).toMatchObject({
      status: "passed",
      attackSuccessRate: 0,
      attempts: 5,
      version: 1,
      threshold: 0.2,
    });
    expect(await currentVersion(id)).toBe(1);
    const versions = (await builder.get(`/v1/agents/${id}/versions`)).json.versions;
    expect(versions[0].score).toMatchObject({ attackSuccessRate: 0, threshold: 0.2 });
    const detail = (await builder.get(`/v1/agents/${id}/evals/${list[0].id}`)).json.eval;
    expect(detail.report.pack).toEqual({ id: "default", version: "1" });

    const [job] = kube.all("Job") as unknown as {
      metadata: { namespace: string };
      spec: { activeDeadlineSeconds: number; template: { spec: Record<string, any> } };
    }[];
    expect(job?.metadata.namespace).toBe("kobe-team-finance");
    expect(job?.spec.activeDeadlineSeconds).toBe(600);
    expect(job?.spec.template.spec.runtimeClassName).toBe("gvisor");
    const env = Object.fromEntries(
      (job?.spec.template.spec.containers[0].env as { name: string; value: string }[]).map((e) => [
        e.name,
        e.value,
      ]),
    );
    // The gateway token is scoped to this team and eval, short-lived, and the only credential.
    const claims = verifySessionToken(
      env.KOBE_MODEL_SESSION_TOKEN as string,
      "kobe.model-gateway",
      KEYS["kobe.model-gateway"],
    );
    expect(claims).toMatchObject({ sub: list[0].id, team_id: finance, user_id: builderId });
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(15 * 60 + 60);
    expect(env.KOBE_EVAL_MODEL).toBe("anthropic/claude-smart");
    expect(JSON.stringify(job)).not.toContain("sealed-provider-key");
    const map = kube.all("ConfigMap")[0] as unknown as { data: Record<string, string> };
    expect(map.data["agent.yaml"]).toContain("You are careful.");

    const events = await h.admin.query(
      `SELECT action FROM audit_log WHERE team_id = $1 AND action LIKE 'agent.eval.%' ORDER BY seq`,
      [finance],
    );
    expect(events.rows.map((r) => r.action)).toEqual([
      "agent.eval.requested",
      "agent.eval.finished",
    ]);
  });

  it("blocks above the threshold: no version, a clear result, the draft stays", async () => {
    await gateOn(0.2);
    jobResult = attacked();
    const id = await draft();
    expect((await publish(id)).status).toBe(202);
    await settled();
    const { evals: list } = await evals(id);
    expect(list[0]).toMatchObject({
      status: "blocked",
      attackSuccessRate: 0.6,
      threshold: 0.2,
      version: null,
    });
    expect(await currentVersion(id)).toBeNull();
  });

  it("errors when a scenario errored or the Job failed: publish stays blocked, then retry succeeds", async () => {
    await gateOn(0.2);
    const id = await draft();
    jobResult = {
      log: report({ errors: 2, attempts: 3 }),
      outcome: "Failed",
      reason: "BackoffLimitExceeded",
    };
    expect((await publish(id)).status).toBe(202);
    await settled();
    let list = (await evals(id)).evals;
    expect(list[0].status).toBe("errored");
    expect(list[0].error).toMatch(/Nothing was published/);
    expect(await currentVersion(id)).toBeNull();

    // A timeout is an error too.
    jobResult = { log: "", outcome: "Failed", reason: "DeadlineExceeded" };
    expect((await publish(id)).status).toBe(202);
    await settled();
    list = (await evals(id)).evals;
    expect(list[0]).toMatchObject({ status: "errored" });
    expect(list[0].error).toMatch(/DeadlineExceeded/);

    // Retry: publishing again is allowed and creates a new eval.
    jobResult = clean();
    expect((await publish(id)).status).toBe(202);
    await settled();
    list = (await evals(id)).evals;
    expect(list.map((e: { status: string }) => e.status)).toEqual(["passed", "errored", "errored"]);
    expect(await currentVersion(id)).toBe(1);
  });

  it("fails closed without the isolation runtime: errored, nothing published", async () => {
    await gateOn();
    gateOpen = false;
    const id = await draft();
    expect((await publish(id)).status).toBe(202);
    await settled();
    const first = (await evals(id)).evals[0];
    expect(first.status).toBe("errored");
    expect(await currentVersion(id)).toBeNull();
  });

  it("publishes exactly what was evaluated, even if the draft changed meanwhile", async () => {
    await gateOn();
    const id = await draft();
    const res = await publish(id);
    expect(res.status).toBe(202);
    await builder.put(
      `/v1/agents/${id}`,
      { frontmatter: { name: "Renamed" }, prompt: "Changed." },
      { "if-match": "1" },
    );
    await settled();
    const version = (await builder.get(`/v1/agents/${id}/versions/1`)).json.version;
    expect(version.prompt).toBe("You are careful.");
  });

  it("gates personal agents used in the team too", async () => {
    await gateOn();
    const id = await draft("personal");
    const res = await publish(id);
    expect(res.status, JSON.stringify(res.json)).toBe(202);
    await settled();
    expect((await evals(id)).evals[0]).toMatchObject({ status: "passed", version: 1 });
  });

  it("refuses an unchanged draft, an unresolvable model and a second concurrent eval", async () => {
    await gateOn();
    const id = await draft();
    expect((await publish(id)).status).toBe(202);
    await settled();
    expect((await publish(id)).json.code).toBe("unchanged");

    const pinned = await builder.post("/v1/agents", {
      scope: "team",
      frontmatter: { name: "Pinned elsewhere", model: "not-enabled" },
      prompt: "x",
    });
    const res = await publish(pinned.json.agent.id);
    expect(res.status).toBe(409);
    expect(res.json.code).toBe("model_not_resolvable");

    jobResult = "hang";
    const slow = await draft();
    expect((await publish(slow)).status).toBe(202);
    const second = await publish(slow);
    expect(second.status).toBe(409);
    expect(second.json.code).toBe("eval_in_progress");
    expect((await evals(slow)).active.status).toBe("running");
    // Let the Job end so its driver finishes.
    jobResult = clean();
    for (const job of kube.all("Job")) if (!job.status) finishJob(kube, job);
    await settled();
    expect((await evals(slow)).evals[0].status).toBe("passed");
  });

  it("members can't publish, so they can't start evals", async () => {
    await gateOn();
    const id = await draft();
    expect((await member.request("POST", `/v1/agents/${id}/publish`, {}, ANY)).status).toBe(403);
  });
});

describe("Publish with the gate on but no runner", () => {
  it("blocks with a clear message instead of publishing unevaluated", async () => {
    await gateOn();
    const app = (await import("./app.js")).createApp(h.deps);
    const { TestBrowser } = await import("./testing/browser.js");
    const b = new TestBrowser(app, "http://kobe.test");
    await b.post("/api/auth/sign-in/email", {
      email: "bob@eval.test",
      password: "a long enough password",
    });
    await b.put("/v1/me/teams/active", { teamId: finance });
    b.team = finance;
    const id = await draft();
    const res = await b.request("POST", `/v1/agents/${id}/publish`, {}, ANY);
    expect(res.status, JSON.stringify(res.json)).toBe(503);
    expect(res.json.code).toBe("eval_unavailable");
    expect(await currentVersion(id)).toBeNull();
  });
});

describe("eval state machine", () => {
  const input = (agentId: string) => ({
    teamId: finance,
    agentId,
    agentScope: "team" as const,
    agentSlug: "sm",
    requestedBy: builderId,
    draftRevision: 1,
    definition: { frontmatter: { name: "SM" }, prompt: "p" },
    model: "anthropic/claude-smart",
    threshold: 0.2,
  });
  const scored = {
    attackSuccessRate: 0,
    attempts: 5,
    attackSuccesses: 0,
    report: {
      schema_version: 1,
      attack_success_rate: 0,
      attempts: 5,
      attack_successes: 0,
      errors: 0,
    },
  } as const;

  it("moves pending -> running -> passed once; a later finish changes nothing", async () => {
    const created = await createEval(h.deps.database.db, input(randomUUID()));
    if (!created.ok) throw new Error("expected an eval");
    const { id } = created.value;
    expect(created.value.status).toBe("pending");
    expect(await markRunning(h.deps.database.db, finance, id, "job")).toBe(true);
    expect(await markRunning(h.deps.database.db, finance, id, "job")).toBe(false);
    const done = await finishEval(h.deps.database.db, finance, id, { status: "passed", ...scored });
    expect(done?.status).toBe("passed");
    expect(
      await finishEval(h.deps.database.db, finance, id, { status: "errored", error: "late" }),
    ).toBeNull();
    expect((await getEval(h.deps.database.db, finance, id))?.status).toBe("passed");
  });

  it("allows one unfinished eval per agent and a retry after any end", async () => {
    const agent = randomUUID();
    const a = await createEval(h.deps.database.db, input(agent));
    expect(await createEval(h.deps.database.db, input(agent))).toEqual({
      ok: false,
      error: "eval_in_progress",
    });
    if (!a.ok) throw new Error("expected an eval");
    await finishEval(h.deps.database.db, finance, a.value.id, { status: "errored", error: "boom" });
    expect((await createEval(h.deps.database.db, input(agent))).ok).toBe(true);
  });

  it("can error straight from pending, and rejects a blocked verdict without a score at the database", async () => {
    const created = await createEval(h.deps.database.db, input(randomUUID()));
    if (!created.ok) throw new Error("expected an eval");
    const done = await finishEval(h.deps.database.db, finance, created.value.id, {
      status: "errored",
      error: "Job could not be created",
    });
    expect(done).toMatchObject({ status: "errored", error: "Job could not be created" });
    await expect(
      h.admin.query(
        `INSERT INTO orbit_evals (team_id, agent_id, agent_scope, agent_slug, requested_by, draft_revision,
           definition, model, threshold, status, finished_at) VALUES ($1, $2, 'team', 's', $3, 1, '{}', 'm', 0.2, 'blocked', now())`,
        [finance, randomUUID(), builderId],
      ),
    ).rejects.toThrow(/orbit_evals_verdict/);
  });

  it("makes the eval id a live gateway principal only while the eval runs", async () => {
    const db = h.deps.database.db;
    const created = await createEval(db, input(randomUUID()));
    if (!created.ok) throw new Error("expected an eval");
    const { id } = created.value;
    const principal = () => loadGatewayPrincipal(db, finance, builderId, id);
    expect((await principal()).sandbox).toBe("revoked");
    await markRunning(db, finance, id, "job");
    expect((await principal()).sandbox).toBe("live");
    // Another user can't present this eval's id.
    expect((await loadGatewayPrincipal(db, finance, adminId, id)).sandbox).toBe("unrecorded");
    await finishEval(db, finance, id, { status: "passed", ...scored });
    expect((await principal()).sandbox).toBe("revoked");
    expect((await readEvalSettings(db, finance)).enabled).toBe(false);
  });
});

describe("sweeper", () => {
  it("errors an eval whose driver died and whose Job is gone, and adopts a finished Job", async () => {
    const db = h.deps.database.db;
    const old = new Date(Date.now() - 3 * 3600_000);
    const stuck = async (job: boolean) => {
      const agentId = randomUUID();
      const created = await createEval(db, {
        teamId: finance,
        agentId,
        agentScope: "team",
        agentSlug: "stuck",
        requestedBy: builderId,
        draftRevision: 1,
        definition: { frontmatter: { name: "Stuck" }, prompt: "p" },
        model: "anthropic/claude-smart",
        threshold: 0.2,
      });
      if (!created.ok) throw new Error("expected an eval");
      await h.admin.query(
        `UPDATE orbit_evals SET created_at = $2, status = 'running' WHERE id = $1`,
        [created.value.id, old],
      );
      if (job) {
        const name = `orbit-eval-${created.value.id}`;
        kube.seed({
          apiVersion: "batch/v1",
          kind: "Job",
          metadata: { name, namespace: "kobe-team-finance" },
          status: { conditions: [{ type: "Complete", status: "True" }] },
        });
        kube.seed({
          apiVersion: "v1",
          kind: "Pod",
          metadata: {
            name: `${name}-p`,
            namespace: "kobe-team-finance",
            labels: { "kobe.splittingatom.io/orbit-eval": created.value.id },
          },
        });
        kube.podLogs.set(
          `kobe-team-finance/${name}-p`,
          report({ attack_success_rate: 0.6, attack_successes: 3 }),
        );
      }
      return created.value.id;
    };
    const lost = await stuck(false);
    const finished = await stuck(true);
    expect(await runner?.sweep()).toBeGreaterThanOrEqual(2);
    expect((await getEval(db, finance, lost))?.status).toBe("errored");
    expect((await getEval(db, finance, finished))?.status).toBe("blocked");
  });
});
