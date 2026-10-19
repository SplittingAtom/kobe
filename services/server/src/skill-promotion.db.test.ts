import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { strToU8, unzipSync, zipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { provenanceSchema } from "@kobe/protocol";
import { RawBody, type TestBrowser } from "./testing/browser.js";
import { openHarness, type Harness } from "./testing/harness.js";
import { MemoryObjects } from "./testing/memory-objects.js";

/**
 * KOBE-333 (SK19, SK20): Promote to Site. The package that leaves is the version's own (payload,
 * evals/, kobe.skill.yaml) with a Kobe-written provenance holding scorecard numbers only; SK20's
 * rules refuse with reasons; a Builder's promotion waits for a Team admin unless the team lets
 * Builders promote, with audits in the team and on the Site; and promotion is the only way skill
 * content leaves a team.
 */
const team = randomUUID();
const other = randomUUID();
const objects = new MemoryObjects();
let h: Harness;
const ids = { admin: "", builder: "", member: "", outsider: "" };
const as = {} as Record<keyof typeof ids, TestBrowser>;

const GOLDEN = JSON.parse(
  readFileSync(
    new URL(
      "../../../packages/protocol/src/skill-evals/fixtures/scorecard/valid-full.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as Record<string, unknown>;
const CASES = readFileSync(
  new URL(
    "../../../packages/protocol/src/skill-evals/fixtures/cases/valid-full.yaml",
    import.meta.url,
  ),
  "utf8",
);

const skillMd = (name: string) =>
  `---\nname: ${name}\ndescription: Builds ${name} reports. Use when asked for a ${name} report.\n---\n# ${name}\nAdd a totals row.\n`;
const manifest = (name: string, semver: string, license = true) =>
  [
    "apiVersion: kobe.dev/skill/v1",
    `name: ${name}`,
    `version: ${semver}`,
    "summary: Builds reports.",
    ...(license ? ["license: Apache-2.0"] : []),
    "changelog: First.",
  ].join("\n") + "\n";
const pkg = (name: string, semver: string, license = true) =>
  new RawBody(
    zipSync({
      "SKILL.md": strToU8(skillMd(name)),
      "kobe.skill.yaml": strToU8(manifest(name, semver, license)),
      "evals/cases.yaml": strToU8(CASES),
      "evals/fixtures/sales.csv": strToU8("region,total\nnorth,1\n"),
      "evals/fixtures/regions/map.json": strToU8("{}"),
    }),
    "application/zip",
  );

async function upload(who: TestBrowser, scope: "team" | "personal", body: RawBody) {
  const res = await who.request("POST", `/v1/skills?scope=${scope}`, body);
  expect(res.status, JSON.stringify(res.json)).toBe(201);
  return res.json as { skill: { id: string }; version: { version: number; semver: string } };
}

/** The version's package hash, as the store recorded it. */
async function packageHash(scope: "team" | "personal", skillId: string, version: number) {
  const table = scope === "team" ? "team_skill_versions" : "personal_skill_versions";
  const r = await h.admin.query<{ package_hash: string }>(
    `SELECT package_hash FROM ${table} WHERE skill_id = $1 AND version = $2`,
    [skillId, version],
  );
  return r.rows[0]?.package_hash as string;
}

/** The team's own review decides the version (D22): approved unless told otherwise. */
async function reviewed(skillId: string, version: number, status = "approved") {
  await h.admin.query(
    `UPDATE team_skill_reviews SET status = $4, reviewed_by = $3, reviewed_at = now()
      WHERE team_id = $1 AND skill_id = $2 AND version = 1 * $5`,
    [team, skillId, ids.admin, status, version],
  );
}

/** A completed full eval of the version in the team, with the golden card's numbers. */
async function evaluated(
  scope: "team" | "personal",
  skillId: string,
  version: number,
  by: string,
  inTeam = team,
) {
  const hash = await packageHash(scope, skillId, version);
  await h.admin.query(
    `INSERT INTO skill_eval_runs (team_id, started_by, subject_kind, subject_id, subject_rev,
       skill_name, package_hash, runtime_hash, bundle_key, bundle_size, mode, status, suite, limits,
       progress_total, progress_done, scorecard, finished_at)
     VALUES ($1, $2, $3, $4, $5, 'x', $6, repeat('b', 64), 'k', 1, 'full', 'completed', '{}', '{}',
       5, 5, $7, now())`,
    [inTeam, by, scope, skillId, version, hash, JSON.stringify({ ...GOLDEN, packageHash: hash })],
  );
  if (scope === "team") await reviewed(skillId, version);
}

beforeAll(async () => {
  h = await openHarness({ blobs: { objects, prefix: "kobe/" } });
  for (const who of Object.keys(ids) as (keyof typeof ids)[])
    ids[who] = await h.createUser(`${who}@promote.test`);
  await h.admin.query(
    `INSERT INTO teams (id, slug, name) VALUES ($1, 'sales', 'Sales'), ($2, 'other', 'Other')`,
    [team, other],
  );
  await h.admin.query(
    `INSERT INTO team_members (team_id, user_id, role) VALUES
       ($1, $2, 'team_admin'), ($1, $3, 'builder'), ($1, $4, 'member'), ($5, $6, 'team_admin')`,
    [team, ids.admin, ids.builder, ids.member, other, ids.outsider],
  );
  for (const who of Object.keys(ids) as (keyof typeof ids)[]) {
    as[who] = await h.signIn(`${who}@promote.test`);
    const t = who === "outsider" ? other : team;
    expect((await as[who].put("/v1/me/teams/active", { teamId: t })).status).toBe(200);
    as[who].team = t;
  }
});

afterAll(async () => {
  await h?.close();
});

const audit = async (action: string) =>
  (
    await h.admin.query<{
      team_id: string | null;
      actor_id: string;
      target: Record<string, unknown>;
    }>(`SELECT team_id, actor_id, target FROM audit_log WHERE action = $1 ORDER BY seq`, [action])
  ).rows;

describe("rules (ac-2)", () => {
  it("refuses with reasons: no scorecard, no license", async () => {
    const made = await upload(as.admin, "team", pkg("no-license", "0.1.0", false));
    const source = { scope: "team", skillId: made.skill.id, version: made.version.version };
    const preview = await as.admin.get(
      `/v1/skills/promotions/preview?scope=team&skillId=${made.skill.id}&version=${made.version.version}`,
    );
    expect(preview.status, JSON.stringify(preview.json)).toBe(200);
    const codes = (preview.json.refusals as { code: string }[]).map((r) => r.code);
    expect(codes).toEqual(expect.arrayContaining(["license", "no_scorecard"]));
    const refused = await as.admin.post("/v1/skills/promotions", source);
    expect([refused.status, refused.json.code]).toEqual([422, "submission_refused"]);
    expect(refused.json.refusals.length).toBeGreaterThan(0);
    expect((await h.admin.query(`SELECT 1 FROM registry_versions`)).rows).toEqual([]);
  });
});

describe("a Team admin's promotion (ac-1)", () => {
  it("submits the version's own package with a Kobe-written provenance (numbers only)", async () => {
    const made = await upload(as.admin, "team", pkg("sales-report", "0.1.0"));
    await evaluated("team", made.skill.id, made.version.version, ids.admin);
    const preview = await as.admin.get(
      `/v1/skills/promotions/preview?scope=team&skillId=${made.skill.id}&version=1`,
    );
    expect(preview.json).toMatchObject({
      name: "sales-report",
      semver: "0.1.0",
      refusals: [],
      newSkill: true,
      fromConversation: false,
      files: [{ path: "SKILL.md" }, { path: "kobe.skill.yaml" }],
    });
    expect((preview.json.fixtures as { path: string }[]).map((f) => f.path)).toEqual([
      "evals/cases.yaml",
      "evals/fixtures/regions/map.json",
      "evals/fixtures/sales.csv",
    ]);
    const res = await as.admin.post("/v1/skills/promotions", {
      scope: "team",
      skillId: made.skill.id,
      version: 1,
    });
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    const versionId = res.json.registryVersionId as string;
    const [row] = (
      await h.admin.query<{
        state: string;
        provenance: Record<string, unknown>;
        source: Record<string, unknown>;
        scorecard: Record<string, unknown>;
        package_storage_key: string;
        package_hash: string;
        submitted_by: string;
      }>(`SELECT * FROM registry_versions WHERE id = $1`, [versionId])
    ).rows;
    expect(row?.state).toBe("submitted");
    expect(row?.submitted_by).toBe(ids.admin);
    const provenance = provenanceSchema.parse(row?.provenance);
    expect(provenance).toMatchObject({
      name: "sales-report",
      version: "0.1.0",
      source: { scope: "team", teamId: team, skillId: made.skill.id, seq: 1 },
      submitter: { userId: ids.admin },
      fromConversation: false,
    });
    // Numbers only: no case ids, threads, runs, prompts or answers anywhere in what left.
    const left = JSON.stringify([row?.provenance, row?.scorecard, row?.source]);
    for (const leak of ["caseId", "threadId", "runId", "prompt", "q3-workbook", "details"])
      expect(left).not.toContain(leak);
    // The stored package is the version's own: payload, evals/ and kobe.skill.yaml, no transcripts.
    const stored = objects.objects.get(row?.package_storage_key as string);
    expect(Object.keys(unzipSync(new Uint8Array(stored as Buffer))).sort()).toEqual([
      "SKILL.md",
      "evals/cases.yaml",
      "evals/fixtures/regions/map.json",
      "evals/fixtures/sales.csv",
      "kobe.skill.yaml",
    ]);
    expect(await audit("skill.promoted")).toMatchObject([
      {
        team_id: team,
        actor_id: ids.admin,
        target: { registryVersionId: versionId, files: 2, fixtures: 3, fromConversation: false },
      },
    ]);
    expect(await audit("registry.submitted")).toMatchObject([
      {
        team_id: null,
        target: { registryVersionId: versionId, name: "sales-report", newSkill: true },
      },
    ]);
    // The same version again is refused: already submitted.
    const again = await as.admin.post("/v1/skills/promotions", {
      scope: "team",
      skillId: made.skill.id,
      version: 1,
    });
    expect((again.json.refusals as { code: string }[]).map((r) => r.code)).toContain(
      "already_submitted",
    );
  });
});

describe("a Builder's promotion (ac-3)", () => {
  it("waits for a Team admin, who sees what leaves and confirms; audited on both sides", async () => {
    const made = await upload(as.builder, "team", pkg("pipeline-check", "0.1.0"));
    await evaluated("team", made.skill.id, 1, ids.builder);
    const source = { scope: "team", skillId: made.skill.id, version: 1 };
    expect((await as.member.post("/v1/skills/promotions", source)).status).toBe(403);
    const asked = await as.builder.post("/v1/skills/promotions", source);
    expect([asked.status, asked.json.state]).toEqual([202, "requested"]);
    const requestId = asked.json.requestId as string;
    expect((await as.builder.post("/v1/skills/promotions", source)).json.code).toBe(
      "already_requested",
    );
    expect((await as.builder.get("/v1/team/skill-promotions")).status).toBe(403);
    const queue = await as.admin.get("/v1/team/skill-promotions");
    expect(queue.json.requests.map((r: { id: string }) => r.id)).toEqual([requestId]);
    const detail = await as.admin.get(`/v1/team/skill-promotions/${requestId}`);
    expect(detail.json).toMatchObject({ fromConversation: false, refusals: [] });
    expect(detail.json.fixtures.length).toBe(3);
    const confirmed = await as.admin.post(`/v1/team/skill-promotions/${requestId}/confirm`, {});
    expect(confirmed.status, JSON.stringify(confirmed.json)).toBe(201);
    const versionId = confirmed.json.registryVersionId as string;
    const [row] = (
      await h.admin.query<{ submitted_by: string; provenance: Record<string, unknown> }>(
        `SELECT submitted_by, provenance FROM registry_versions WHERE id = $1`,
        [versionId],
      )
    ).rows;
    expect(row?.submitted_by).toBe(ids.builder);
    expect(row?.provenance).toMatchObject({ confirmedBy: { userId: ids.admin } });
    expect(await audit("skill.promotion.requested")).toMatchObject([
      { team_id: team, actor_id: ids.builder, target: { requestId } },
    ]);
    expect(await audit("skill.promotion.confirmed")).toMatchObject([
      { team_id: team, actor_id: ids.admin, target: { requestId, registryVersionId: versionId } },
    ]);
    expect((await audit("skill.promoted")).at(-1)).toMatchObject({ target: { requestId } });
  });

  it("is declined by a Team admin, or goes straight through when the team allows it", async () => {
    const made = await upload(as.builder, "team", pkg("ledger-tidy", "0.1.0"));
    await evaluated("team", made.skill.id, 1, ids.builder);
    const source = { scope: "team", skillId: made.skill.id, version: 1 };
    const asked = await as.builder.post("/v1/skills/promotions", source);
    const declined = await as.admin.post(
      `/v1/team/skill-promotions/${asked.json.requestId}/decline`,
      { note: "Not yet." },
    );
    expect(declined.status).toBe(200);
    expect((await audit("skill.promotion.declined")).length).toBe(1);
    const on = await as.admin.put("/v1/team/skill-review/settings", { buildersMayPromote: true });
    expect(on.json.buildersMayPromote).toBe(true);
    const direct = await as.builder.post("/v1/skills/promotions", source);
    expect([direct.status, direct.json.state]).toEqual([201, "submitted"]);
  });
});

describe("a personal promotion (ac-1)", () => {
  it("is its author's to make, from the active team, without confirmation", async () => {
    const made = await upload(as.member, "personal", pkg("my-notes-skill", "0.1.0"));
    await evaluated("personal", made.skill.id, 1, ids.member);
    const source = { scope: "personal", skillId: made.skill.id, version: 1 };
    // Someone else's personal skill is not there to promote.
    expect((await as.builder.post("/v1/skills/promotions", source)).status).toBe(404);
    const res = await as.member.post("/v1/skills/promotions", source);
    expect([res.status, res.json.state], JSON.stringify(res.json)).toEqual([201, "submitted"]);
    const [row] = (
      await h.admin.query<{ provenance: Record<string, unknown> }>(
        `SELECT provenance FROM registry_versions WHERE id = $1`,
        [res.json.registryVersionId],
      )
    ).rows;
    expect(row?.provenance).toMatchObject({
      source: { scope: "personal", teamId: team, skillId: made.skill.id },
      submitter: { userId: ids.member },
    });
  });
});

describe("teams are walls (ac-4)", () => {
  it("lets no other path move a team's skill content: only promotion did", async () => {
    const made = await upload(as.admin, "team", pkg("wall-test", "0.1.0"));
    // The other team's admin can't read, fork, preview or promote it.
    expect((await as.outsider.get(`/v1/skills/${made.skill.id}?scope=team`)).status).toBe(404);
    expect(
      (
        await as.outsider.post("/v1/skills/drafts/fork", {
          source: { kind: "team", skillId: made.skill.id, version: 1 },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await as.outsider.get(
          `/v1/skills/promotions/preview?scope=team&skillId=${made.skill.id}&version=1`,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await as.outsider.post("/v1/skills/promotions", {
          scope: "team",
          skillId: made.skill.id,
          version: 1,
        })
      ).status,
    ).toBe(404);
    // Nothing of it is in the Registry: it was never promoted.
    const r = await h.admin.query(
      `SELECT 1 FROM registry_versions WHERE source ->> 'skillId' = $1`,
      [made.skill.id],
    );
    expect(r.rows).toEqual([]);
  });
});

describe("review fixes (KOBE-333 review)", () => {
  it("promotes only a version the team's review approved (C4-M2)", async () => {
    const made = await upload(as.admin, "team", pkg("needs-review", "0.1.0"));
    await evaluated("team", made.skill.id, 1, ids.admin);
    const preview = (status: string) =>
      reviewed(made.skill.id, 1, status).then(() =>
        as.admin.get(`/v1/skills/promotions/preview?scope=team&skillId=${made.skill.id}&version=1`),
      );
    for (const status of ["rejected", "pending"]) {
      if (status === "pending")
        await h.admin.query(
          `UPDATE team_skill_reviews SET status = 'pending', reviewed_by = NULL, reviewed_at = NULL
            WHERE skill_id = $1`,
          [made.skill.id],
        );
      const r =
        status === "pending"
          ? await as.admin.get(
              `/v1/skills/promotions/preview?scope=team&skillId=${made.skill.id}&version=1`,
            )
          : await preview(status);
      expect(
        (r.json.refusals as { code: string }[]).map((x) => x.code),
        status,
      ).toContain("team_review");
      const sent = await as.admin.post("/v1/skills/promotions", {
        scope: "team",
        skillId: made.skill.id,
        version: 1,
      });
      expect([sent.status, sent.json.code]).toEqual([422, "submission_refused"]);
    }
  });

  it("re-checks the team's review inside the submission (re-review LOW-R2)", async () => {
    const made = await upload(as.admin, "team", pkg("late-reject", "0.1.0"));
    await evaluated("team", made.skill.id, 1, ids.admin);
    // The team's review rejects the version after the preview's check, just before the
    // submission's transaction (its catalog bytes are being written).
    const get = objects.get.bind(objects);
    objects.get = async (key, options) => {
      if (key.includes("skills/catalog/")) {
        objects.get = get;
        await reviewed(made.skill.id, 1, "rejected");
      }
      return get(key, options);
    };
    try {
      const res = await as.admin.post("/v1/skills/promotions", {
        scope: "team",
        skillId: made.skill.id,
        version: 1,
      });
      expect([res.status, res.json.code]).toEqual([422, "submission_refused"]);
      expect((res.json.refusals as { code: string }[]).map((r) => r.code)).toEqual(["team_review"]);
    } finally {
      objects.get = get;
    }
    const r = await h.admin.query(`SELECT 1 FROM registry_skills WHERE name = 'late-reject'`);
    expect(r.rows).toEqual([]);
  });

  it("lets the first decision on a request win; the second gets 409 (C4-M1)", async () => {
    // An earlier test let Builders promote directly: their promotions wait again.
    await as.admin.put("/v1/team/skill-review/settings", { buildersMayPromote: false });
    const made = await upload(as.builder, "team", pkg("race-skill", "0.1.0"));
    await evaluated("team", made.skill.id, 1, ids.builder);
    const source = { scope: "team", skillId: made.skill.id, version: 1 };
    const firstRes = await as.builder.post("/v1/skills/promotions", source);
    expect(firstRes.status, JSON.stringify(firstRes.json)).toBe(202);
    const first = firstRes.json.requestId as string;
    // Decline, then confirm: refused, nothing submitted.
    expect((await as.admin.post(`/v1/team/skill-promotions/${first}/decline`, {})).status).toBe(
      200,
    );
    const late = await as.admin.post(`/v1/team/skill-promotions/${first}/confirm`, {});
    expect([late.status, late.json.code]).toEqual([409, "request_closed"]);
    expect((await as.admin.post(`/v1/team/skill-promotions/${first}/decline`, {})).json.code).toBe(
      "request_closed",
    );
    // At once: one confirm and one decline; exactly one wins.
    const second = (await as.builder.post("/v1/skills/promotions", source)).json
      .requestId as string;
    const [a, b] = await Promise.all([
      as.admin.post(`/v1/team/skill-promotions/${second}/confirm`, {}),
      as.admin.post(`/v1/team/skill-promotions/${second}/decline`, {}),
    ]);
    expect([a.status, b.status].sort()).toEqual(a.status === 201 ? [201, 409] : [200, 409]);
    const state = await h.admin.query(`SELECT state FROM skill_promotion_requests WHERE id = $1`, [
      second,
    ]);
    const submitted = await h.admin.query(
      `SELECT count(*)::int AS n FROM registry_versions WHERE source ->> 'skillId' = $1`,
      [made.skill.id],
    );
    expect(submitted.rows[0]?.n).toBe(state.rows[0]?.state === "confirmed" ? 1 : 0);
    // A double confirm on a fresh request: the second is 409, never a 500.
    if (state.rows[0]?.state !== "confirmed") {
      const third = (await as.builder.post("/v1/skills/promotions", source)).json
        .requestId as string;
      const [c1, c2] = await Promise.all([
        as.admin.post(`/v1/team/skill-promotions/${third}/confirm`, {}),
        as.admin.post(`/v1/team/skill-promotions/${third}/confirm`, {}),
      ]);
      expect([c1.status, c2.status].sort()).toEqual([201, 409]);
    }
  });
});

/**
 * A Workbench draft that started from a conversation (as Save to Workbench or save_skill_draft
 * make it), written directly: its files are a full package.
 */
async function conversationDraft(ownerId: string, name: string): Promise<string> {
  const draft = randomUUID();
  await h.admin.query("BEGIN");
  try {
    await h.admin.query(`SELECT set_config('kobe.team_id', $1, true)`, [team]);
    await h.admin.query(
      `INSERT INTO skill_drafts (team_id, id, owner_user_id, name, started_from, from_thread_id,
         updated_by, synced_rev)
       VALUES ($1, $2, $3, $4, 'thread', $5, $3, 1)`,
      [team, draft, ownerId, name, randomUUID()],
    );
    const files: Record<string, string> = {
      "SKILL.md": skillMd(name),
      "kobe.skill.yaml": manifest(name, "0.1.0"),
      "evals/cases.yaml": CASES,
      "evals/fixtures/sales.csv": "region,total\nnorth,1\n",
      "evals/fixtures/regions/map.json": "{}",
    };
    for (const [path, text] of Object.entries(files))
      await h.admin.query(
        `INSERT INTO skill_draft_files (team_id, draft_id, path, text_content, size, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [team, draft, path, text, Buffer.byteLength(text), ownerId],
      );
    await h.admin.query("COMMIT");
  } catch (err) {
    await h.admin.query("ROLLBACK");
    throw err;
  }
  // The draft's audit row, as createDraft writes it (promotion's backfill and checks read it).
  await h.admin.query(
    `INSERT INTO audit_log (actor_kind, actor_id, action, team_id, target)
     VALUES ('user', $1, 'skill.draft.created', $2, $3)`,
    [ownerId, team, JSON.stringify({ draftId: draft, name, startedFrom: "thread" })],
  );
  return draft;
}

async function saveDraft(
  who: TestBrowser,
  draftId: string,
  destination: "team" | "personal",
  semver: string,
) {
  const rev = (await who.get(`/v1/skills/drafts/${draftId}`)).json.draft.rev as number;
  const res = await who.request(
    "POST",
    `/v1/skills/drafts/${draftId}/versions`,
    { destination, semver, changelog: "Saved.", confirmPersonal: true },
    { "if-match": `"${rev}"` },
  );
  expect(res.status, JSON.stringify(res.json)).toBe(201);
  return res.json as { skill: { id: string }; version: { version: number } };
}

describe("from a conversation (KOBE-333 review C4-M3)", () => {
  it("is true for a version saved from a conversation draft, in the plan, provenance and audit", async () => {
    const draft = await conversationDraft(ids.admin, "chat-report");
    const saved = await saveDraft(as.admin, draft, "team", "0.1.0");
    await evaluated("team", saved.skill.id, 1, ids.admin);
    const source = { scope: "team", skillId: saved.skill.id, version: 1 };
    const preview = await as.admin.get(
      `/v1/skills/promotions/preview?scope=team&skillId=${saved.skill.id}&version=1`,
    );
    expect(preview.json).toMatchObject({ fromConversation: true, refusals: [] });
    const res = await as.admin.post("/v1/skills/promotions", source);
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    const row = await h.admin.query(`SELECT provenance FROM registry_versions WHERE id = $1`, [
      res.json.registryVersionId,
    ]);
    expect(row.rows[0]?.provenance).toMatchObject({ fromConversation: true });
    expect((await audit("skill.promoted")).at(-1)).toMatchObject({
      target: { fromConversation: true },
    });

    // A fork of it, saved as the next version: still from a conversation.
    const fork = await as.admin.post("/v1/skills/drafts/fork", {
      source: { kind: "team", skillId: saved.skill.id, version: 1 },
    });
    expect(fork.status, JSON.stringify(fork.json)).toBe(201);
    const next = await saveDraft(as.admin, fork.json.draft.id as string, "team", "0.2.0");
    expect(next.version.version).toBe(2);
    const flags = await h.admin.query(
      `SELECT version, from_conversation FROM team_skill_versions WHERE skill_id = $1 ORDER BY version`,
      [saved.skill.id],
    );
    expect(flags.rows).toEqual([
      { version: 1, from_conversation: true },
      { version: 2, from_conversation: true },
    ]);
    // A direct upload of the same files is not.
    const direct = await upload(as.admin, "team", pkg("plain-upload", "0.1.0"));
    const flag = await h.admin.query(
      `SELECT from_conversation FROM team_skill_versions WHERE skill_id = $1`,
      [direct.skill.id],
    );
    expect(flag.rows).toEqual([{ from_conversation: false }]);
  });

  it("is true for a personal skill promoted from another team", async () => {
    await h.admin.query(
      `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'member')`,
      [other, ids.builder],
    );
    const draft = await conversationDraft(ids.builder, "my-chat-skill");
    const saved = await saveDraft(as.builder, draft, "personal", "0.1.0");
    // Promoted while the other team is active (its eval ran there).
    expect((await as.builder.put("/v1/me/teams/active", { teamId: other })).status).toBe(200);
    as.builder.team = other;
    try {
      await evaluated("personal", saved.skill.id, 1, ids.builder, other);
      const preview = await as.builder.get(
        `/v1/skills/promotions/preview?scope=personal&skillId=${saved.skill.id}&version=1`,
      );
      expect(preview.json).toMatchObject({ fromConversation: true, refusals: [] });
      const res = await as.builder.post("/v1/skills/promotions", {
        scope: "personal",
        skillId: saved.skill.id,
        version: 1,
      });
      expect(res.status, JSON.stringify(res.json)).toBe(201);
      const row = await h.admin.query(`SELECT provenance FROM registry_versions WHERE id = $1`, [
        res.json.registryVersionId,
      ]);
      expect(row.rows[0]?.provenance).toMatchObject({
        fromConversation: true,
        source: { scope: "personal", teamId: other },
      });
    } finally {
      await as.builder.put("/v1/me/teams/active", { teamId: team });
      as.builder.team = team;
    }
  });
});
