import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { EvalRunner } from "./agents/eval/service.js";
import { seedGalleryAgents } from "./gallery/seed.js";
import type { SandboxSettings } from "./sandbox/config.js";
import type { KubeObject } from "./sandbox/manifests.js";
import { createFakeKube, type FakeKube } from "./testing/fake-kube.js";
import { openHarness, type Harness } from "./testing/harness.js";
import type { TestBrowser } from "./testing/browser.js";
import { KEYS, SETTINGS, gateFor, seedCluster } from "./testing/sandbox-fixtures.js";

/**
 * Orbit scores shown in the inventory and published for gallery agents (KOBE-94). The eval Job is
 * simulated as in orbit-eval.db.test.ts; the install admin's eval runs in one of their teams and
 * its verdict becomes an install-level score every team reads.
 */
const finance = randomUUID();
const marketing = randomUUID();
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
let owner: TestBrowser;
let builder: TestBrowser;
let teamAdmin: TestBrowser;
let jobLog: { log: string; outcome: "Complete" | "Failed" };

const report = (over: Record<string, unknown> = {}) =>
  `ok\n${JSON.stringify(
    {
      schema_version: 1,
      attack_success_rate: 0,
      attempts: 5,
      attack_successes: 0,
      errors: 0,
      pack: { id: "kobe-default", version: 1 },
      ...over,
    },
    null,
    2,
  )}\n`;

function finishJob(fake: FakeKube, object: KubeObject): void {
  if (object.kind !== "Job") return;
  const ns = object.metadata.namespace as string;
  const evalId = object.metadata.labels?.["kobe.splittingatom.io/orbit-eval"] as string;
  const pod = `${object.metadata.name}-x7k2p`;
  fake.seed({
    apiVersion: "v1",
    kind: "Pod",
    metadata: { name: pod, namespace: ns, labels: { "kobe.splittingatom.io/orbit-eval": evalId } },
  });
  fake.podLogs.set(`${ns}/${pod}`, jobLog.log);
  fake.seed({ ...object, status: { conditions: [{ type: jobLog.outcome, status: "True" }] } });
}

let ownerId: string;
let builderId: string;
let adminId: string;

beforeAll(async () => {
  kube = createFakeKube();
  seedCluster(kube);
  kube.afterWrite = (object) => finishJob(kube, object);
  const isolation = gateFor(kube);
  h = await openHarness({}, (deps) => ({
    evals: new EvalRunner({
      db: deps.database.db,
      kube,
      provider: { ensureTeam: async () => "kobe-team-finance" },
      isolation,
      settings: sandbox,
      sessionKeys: KEYS,
      pollMs: 1,
    }),
  }));
  ownerId = await h.createUser("owner@scores.test", "owner");
  builderId = await h.createUser("bob@scores.test");
  adminId = await h.createUser("alice@scores.test");
  for (const [id, slug] of [
    [finance, "finance"],
    [marketing, "marketing"],
  ] as const) {
    await h.admin.query(`INSERT INTO teams (id, slug, name) VALUES ($1, $2, $2)`, [id, slug]);
  }
  for (const [team, user, role] of [
    [finance, ownerId, "team_admin"],
    [finance, builderId, "builder"],
    [finance, adminId, "team_admin"],
  ] as const) {
    await h.admin.query(`INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, $3)`, [
      team,
      user,
      role,
    ]);
  }
  await h.admin.query(
    `INSERT INTO model_providers (id, kind, name, api_key_enc, created_by)
     VALUES ('anthropic', 'anthropic', 'anthropic', 'v2.test.sealed-provider-key', $1)`,
    [ownerId],
  );
  await h.admin.query(
    `INSERT INTO model_catalog (alias, provider_id, model, created_by) VALUES ('smart', 'anthropic', 'claude-smart', $1)`,
    [ownerId],
  );
  await h.admin.query(
    `INSERT INTO team_models (team_id, alias, is_default, enabled_by) VALUES ($1, 'smart', true, $2)`,
    [finance, ownerId],
  );
  for (const [email, set] of [
    ["owner@scores.test", (b: TestBrowser) => (owner = b)],
    ["bob@scores.test", (b: TestBrowser) => (builder = b)],
    ["alice@scores.test", (b: TestBrowser) => (teamAdmin = b)],
  ] as const) {
    const b = await h.signIn(email);
    expect((await b.put("/v1/me/teams/active", { teamId: finance })).status).toBe(200);
    b.team = finance;
    set(b);
  }
  await seedGalleryAgents(h.deps.database.db);
});

afterAll(async () => {
  await h?.close();
});

beforeEach(async () => {
  jobLog = { log: report(), outcome: "Complete" };
  await h.admin.query(`DELETE FROM gallery_agent_scores`);
  await h.admin.query(`DELETE FROM orbit_evals`);
});

const galleryId = async (key: string): Promise<string> =>
  (
    await h.admin.query<{ id: string }>(`SELECT id FROM install_agents WHERE gallery_key = $1`, [
      key,
    ])
  ).rows[0]?.id as string;

const runEval = (id: string, teamId = finance, who: TestBrowser = owner) =>
  who.post(`/v1/install/gallery/agents/${id}/eval`, { teamId });

describe("gallery scores (install level)", () => {
  it("runs the eval in the admin's team, publishes nothing and stores the score", async () => {
    const id = await galleryId("assistant");
    const before = (
      await h.admin.query(`SELECT current_version FROM install_agents WHERE id = $1`, [id])
    ).rows[0];
    const res = await runEval(id);
    expect(res.status, JSON.stringify(res.json)).toBe(202);
    await h.deps.background.idle();

    const scores = (await owner.get("/v1/install/gallery/agents/scores")).json.scores;
    expect(scores).toHaveLength(1);
    expect(scores[0]).toMatchObject({
      agentId: id,
      version: 1,
      status: "passed",
      attackSuccessRate: 0,
      attempts: 5,
      threshold: 0.2,
    });
    expect(scores[0].evaluatedAt).toMatch(/^\d{4}-/);
    expect(
      (await h.admin.query(`SELECT current_version FROM install_agents WHERE id = $1`, [id]))
        .rows[0],
    ).toEqual(before);
    const [job] = kube.all("Job") as unknown as { metadata: { namespace: string } }[];
    expect(job?.metadata.namespace).toBe("kobe-team-finance");
    // The execution record is the host team's eval row, scope gallery.
    const rows = (await h.admin.query(`SELECT agent_scope, team_id, version FROM orbit_evals`))
      .rows;
    expect(rows).toEqual([{ agent_scope: "gallery", team_id: finance, version: null }]);
  });

  it("any team reads the published scores; the score above the limit is blocked", async () => {
    const id = await galleryId("researcher");
    jobLog = {
      log: report({ attack_success_rate: 0.6, attack_successes: 3 }),
      outcome: "Complete",
    };
    expect((await runEval(id)).status).toBe(202);
    await h.deps.background.idle();
    const seen = (await builder.get("/v1/agents/gallery-scores")).json.scores;
    expect(seen).toEqual([
      expect.objectContaining({ agentId: id, status: "blocked", attackSuccessRate: 0.6 }),
    ]);
  });

  it("stores nothing when the eval errors", async () => {
    const id = await galleryId("assistant");
    jobLog = { log: "error: boom\n", outcome: "Failed" };
    expect((await runEval(id)).status).toBe(202);
    await h.deps.background.idle();
    expect((await owner.get("/v1/install/gallery/agents/scores")).json.scores).toEqual([]);
    expect(
      (await h.admin.query(`SELECT status FROM orbit_evals`)).rows.map((r) => r.status),
    ).toEqual(["errored"]);
  });

  it("rolls the verdict back when the score can't be stored: no passed eval without a score", async () => {
    await h.admin.query(`CREATE FUNCTION fail_score() RETURNS trigger LANGUAGE plpgsql AS
      $$ BEGIN RAISE EXCEPTION 'score insert failed'; END $$`);
    await h.admin.query(`CREATE TRIGGER fail_score BEFORE INSERT ON gallery_agent_scores
      FOR EACH ROW EXECUTE FUNCTION fail_score()`);
    try {
      const id = await galleryId("assistant");
      expect((await runEval(id)).status).toBe(202);
      await h.deps.background.idle();
      expect((await h.admin.query(`SELECT 1 FROM gallery_agent_scores`)).rows).toEqual([]);
      const rows = (await h.admin.query(`SELECT id, status FROM orbit_evals`)).rows;
      expect(rows.map((r) => r.status)).toEqual(["errored"]);
      expect(
        (
          await h.admin.query(
            `SELECT 1 FROM audit_log WHERE action = 'agent.eval.finished' AND target->>'evalId' = $1 AND target->>'status' = 'passed'`,
            [rows[0]?.id],
          )
        ).rows,
      ).toEqual([]);
    } finally {
      await h.admin.query(`DROP TRIGGER fail_score ON gallery_agent_scores`);
      await h.admin.query(`DROP FUNCTION fail_score()`);
    }
  });

  it("scores the current version only: a newer version has none until it is evaluated", async () => {
    const id = await galleryId("assistant");
    expect((await runEval(id)).status).toBe(202);
    await h.deps.background.idle();
    await h.admin.query(
      `INSERT INTO install_agent_versions (agent_id, version, frontmatter, prompt, tool_manifest, draft_revision)
       SELECT agent_id, 2, frontmatter, prompt, tool_manifest, 1 FROM install_agent_versions
        WHERE agent_id = $1 AND version = 1`,
      [id],
    );
    await h.admin.query(`UPDATE install_agents SET current_version = 2 WHERE id = $1`, [id]);
    expect((await builder.get("/v1/agents/gallery-scores")).json.scores).toEqual([]);
  });

  it("is for install admins, in a team they belong to, and one eval at a time", async () => {
    const id = await galleryId("assistant");
    expect((await runEval(id, finance, builder)).status).toBe(403);
    expect((await runEval(id, marketing)).status).toBe(404); // not a member
    expect((await runEval(id, randomUUID())).status).toBe(404);
    expect((await runEval(randomUUID())).status).toBe(404);
    expect((await owner.post(`/v1/install/gallery/agents/${id}/eval`, {})).status).toBe(400);
    expect((await builder.get("/v1/install/gallery/agents/scores")).status).toBe(403);
  });
});

describe("inventory scores", () => {
  type Item = {
    id: string;
    orbitScore: { status: string; attackSuccessRate: number | null; at: string | null };
  };
  const inventory = async (): Promise<Item[]> => {
    const res = await teamAdmin.get("/v1/agents/inventory");
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    return res.json.agents as Item[];
  };
  const score = async (id: string) => (await inventory()).find((a) => a.id === id)?.orbitScore;

  async function teamAgent(): Promise<string> {
    const created = await builder.post("/v1/agents", {
      scope: "team",
      frontmatter: { name: `Scored ${randomUUID().slice(0, 6)}` },
      prompt: "You are careful.",
    });
    const id = created.json.agent.id as string;
    expect(
      (await builder.request("POST", `/v1/agents/${id}/publish`, {}, { "if-match": "*" })).status,
    ).toBe(201);
    return id;
  }

  const evalRow = (agent: string, status: string, rate: number | null, ageMinutes: number) =>
    h.admin.query(
      `INSERT INTO orbit_evals (team_id, agent_id, agent_scope, agent_slug, requested_by, draft_revision,
         definition, model, status, threshold, attack_success_rate, attempts, attack_successes, error,
         created_at, finished_at)
       VALUES ($1, $2, 'team', 'x', $3, 1, '{}', 'm', $4, 0.2, $5, $6, 0, $7,
         now() - make_interval(mins => $8), $9)`,
      [
        finance,
        agent,
        builderId,
        status,
        rate,
        rate === null ? null : 5,
        status === "errored" ? "boom" : null,
        ageMinutes,
        status === "pending" || status === "running" ? null : new Date(),
      ],
    );

  it("shows none, then the latest eval: errored, evaluating, blocked, passed", async () => {
    const id = await teamAgent();
    expect(await score(id)).toEqual({ status: "none", attackSuccessRate: null, at: null });
    await evalRow(id, "passed", 0.1, 30);
    await evalRow(id, "errored", null, 20);
    expect(await score(id)).toMatchObject({ status: "errored", attackSuccessRate: null });
    await evalRow(id, "running", null, 10);
    expect(await score(id)).toMatchObject({ status: "evaluating", attackSuccessRate: null });
    await h.admin.query(`DELETE FROM orbit_evals WHERE status IN ('running', 'errored')`);
    await evalRow(id, "blocked", 0.6, 5);
    expect(await score(id)).toMatchObject({ status: "blocked", attackSuccessRate: 0.6 });
    await h.admin.query(`DELETE FROM orbit_evals WHERE status = 'blocked'`);
    expect(await score(id)).toMatchObject({ status: "passed", attackSuccessRate: 0.1 });
  });

  it("never shows another team's evals", async () => {
    const id = await teamAgent();
    await h.admin.query(
      `INSERT INTO orbit_evals (team_id, agent_id, agent_scope, agent_slug, requested_by, draft_revision,
         definition, model, status, threshold, attack_success_rate, attempts, attack_successes, finished_at)
       VALUES ($1, $2, 'team', 'x', $3, 1, '{}', 'm', 'passed', 0.2, 0, 5, 0, now())`,
      [marketing, id, builderId],
    );
    expect((await score(id))?.status).toBe("none");
  });

  it("shows the install-level score of a gallery agent used in the team", async () => {
    const id = await galleryId("data-analyst");
    const thread = await builder.post("/v1/threads", { agent_id: id });
    expect(thread.status, JSON.stringify(thread.json)).toBe(201);
    expect(await score(id)).toMatchObject({ status: "none" });
    expect((await runEval(id)).status).toBe(202);
    await h.deps.background.idle();
    expect(await score(id)).toMatchObject({ status: "passed", attackSuccessRate: 0 });
    expect((await score(id))?.at).toMatch(/^\d{4}-/);
  });
});
