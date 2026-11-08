import { randomUUID } from "node:crypto";
import { strToU8, zipSync } from "fflate";
import { recordModelUsage } from "@kobe/db";
import { SERVER_CALL_TOKEN_HEADER, type ServerCallClaims } from "@kobe/protocol";
import { generateSessionKeyPair, verifyServerCallToken } from "@kobe/session-token";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RawBody, type TestBrowser } from "./testing/browser.js";
import { openHarness, type Harness } from "./testing/harness.js";
import { MemoryObjects } from "./testing/memory-objects.js";
import { pkg } from "./testing/registry-fixtures.js";

/**
 * KOBE-564 ac-4: Create kobe.skill.yaml for a version without one, end to end against Postgres
 * with the real server-call client and a gateway stand-in that verifies the token (a run-less
 * `skill_manifest` claim), answers as a model would and writes the ledger row the gateway writes.
 * The version is forked into a draft of the member's with the file in place; the version itself
 * stays as it was.
 */
const team = randomUUID();
const objects = new MemoryObjects();
const PAIR = generateSessionKeyPair();
let h: Harness;
let builder: TestBrowser;
let member: TestBrowser;
let builderId = "";
let memberId = "";

interface GatewayCall {
  readonly claims: ServerCallClaims;
  readonly body: { model: string; messages: { role: string; content: string }[] };
}
const gateway = {
  calls: [] as GatewayCall[],
  reply: (_call: GatewayCall): string | { status: number; code: string } =>
    JSON.stringify({
      summary: "Builds the quarterly sales report from the warehouse.",
      tags: ["sales", "not valid tag"],
      capabilities: {
        egress: ["https://warehouse.example.com/api"],
        packages: { pip: ["pandas"] },
      },
    }),
};

/** The gateway as far as the server can tell: token, no run on this purpose, ledger row, reply. */
const gatewayFetch: typeof fetch = async (_url, init) => {
  const headers = init?.headers as Record<string, string>;
  const verified = verifyServerCallToken(
    PAIR.verify,
    headers[SERVER_CALL_TOKEN_HEADER] ?? "",
    Math.floor(Date.now() / 1000),
  );
  if (!verified.ok) return new Response("{}", { status: 401 });
  const { claims } = verified;
  const call = { claims, body: JSON.parse(String(init?.body)) as GatewayCall["body"] };
  gateway.calls.push(call);
  const answer = gateway.reply(call);
  if (typeof answer !== "string")
    return new Response(JSON.stringify({ error: { code: answer.code } }), {
      status: answer.status,
    });
  await recordModelUsage(h.deps.database.db, [
    {
      id: randomUUID(),
      teamId: claims.team_id,
      userId: claims.user_id,
      sandboxId: undefined,
      runId: claims.run_id,
      kind: claims.purpose,
      at: new Date(),
      route: "openai",
      model: claims.model,
      status: 200,
      inputTokens: 500,
      outputTokens: 80,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      usageSource: "reported",
      durationMs: 30,
      ttfbMs: 10,
      aborted: false,
    },
  ]);
  return new Response(
    JSON.stringify({
      choices: [{ message: { role: "assistant", content: answer }, finish_reason: "stop" }],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
};

const skillMd = (name: string) =>
  `---\nname: ${name}\ndescription: Builds ${name} reports. Use when asked for a ${name} report.\n---\n# ${name}\nAdd a totals row.\n`;
/** A team version without a manifest (the upload the panel refuses to promote). */
const bare = (name: string) =>
  new RawBody(
    zipSync({
      "SKILL.md": strToU8(skillMd(name)),
      "scripts/report.py": strToU8("import pandas\n"),
    }),
    "application/zip",
  );

async function uploadTeam(who: TestBrowser, body: RawBody) {
  const res = await who.request("POST", "/v1/skills?scope=team", body);
  expect(res.status, JSON.stringify(res.json)).toBe(201);
  const made = res.json as { skill: { id: string }; version: { version: number; semver: string } };
  return { skillId: made.skill.id, version: made.version.version, semver: made.version.semver };
}

async function draftFiles(who: TestBrowser, draftId: string) {
  const res = await who.get(`/v1/skills/drafts/${draftId}`);
  expect(res.status).toBe(200);
  return (res.json.files as { path: string }[]).map((f) => f.path).sort();
}

beforeAll(async () => {
  h = await openHarness({
    blobs: { objects, prefix: "kobe/" },
    serverCalls: { gatewayUrl: "http://gateway.invalid", key: PAIR.signing, fetch: gatewayFetch },
  });
  builderId = await h.createUser("builder@manifest.test");
  memberId = await h.createUser("member@manifest.test");
  await h.admin.query(`INSERT INTO teams (id, slug, name) VALUES ($1, 'manifest', 'Manifest')`, [
    team,
  ]);
  await h.admin.query(
    `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'builder'), ($1, $3, 'member')`,
    [team, builderId, memberId],
  );
  await h.admin.query(
    `INSERT INTO model_providers (id, kind, name, api_key_enc, created_by)
     VALUES ('openai', 'openai', 'openai', 'v2.test.sealed-provider-key', $1) ON CONFLICT (id) DO NOTHING`,
    [builderId],
  );
  await h.admin.query(
    `INSERT INTO model_catalog (alias, provider_id, model, input_usd_per_mtok, output_usd_per_mtok, created_by)
     VALUES ('k2', 'openai', 'k2-fake', 2, 10, $1), ('glm', 'openai', 'glm-fake', 1, 5, $1), ('off', 'openai', 'off-fake', 1, 1, $1)`,
    [builderId],
  );
  await h.admin.query(
    `INSERT INTO team_models (team_id, alias, is_default, enabled_by)
     VALUES ($1, 'k2', true, $2), ($1, 'glm', false, $2)`,
    [team, builderId],
  );
  await h.admin.query(
    `INSERT INTO registry_tags (name, kind) VALUES ('sales', 'topic'), ('finance', 'topic')
     ON CONFLICT (name) DO NOTHING`,
  );
  builder = await h.signIn("builder@manifest.test");
  member = await h.signIn("member@manifest.test");
  for (const who of [builder, member]) {
    expect((await who.put("/v1/me/teams/active", { teamId: team })).status).toBe(200);
    who.team = team;
  }
});

afterAll(async () => {
  await h?.close();
});

beforeEach(() => {
  gateway.calls = [];
  gateway.reply = () =>
    JSON.stringify({
      summary: "Builds the quarterly sales report from the warehouse.",
      tags: ["sales", "not valid tag"],
      capabilities: {
        egress: ["https://warehouse.example.com/api"],
        packages: { pip: ["pandas"] },
      },
    });
});

describe("POST /v1/skills/promotions/manifest (KOBE-564)", () => {
  it("the preview refuses the version for no_manifest; Kobe then drafts one with the chosen model into a new draft", async () => {
    const v = await uploadTeam(builder, bare("sales-report"));
    const preview = await builder.get(
      `/v1/skills/promotions/preview?scope=team&skillId=${v.skillId}&version=${v.version}`,
    );
    expect(preview.status).toBe(200);
    expect((preview.json.refusals as { code: string }[]).map((r) => r.code)).toContain(
      "no_manifest",
    );

    const res = await builder.post("/v1/skills/promotions/manifest", {
      scope: "team",
      skillId: v.skillId,
      version: v.version,
      model: "glm",
      license: "Apache-2.0",
    });
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    expect(res.json).toMatchObject({
      model: "glm",
      source: "model",
      draft: { name: "sales-report", startedFrom: "fork", mine: true, rev: 1 },
      manifest: {
        apiVersion: "kobe.dev/skill/v1",
        name: "sales-report",
        version: v.semver,
        summary: "Builds the quarterly sales report from the warehouse.",
        tags: ["sales"],
        license: "Apache-2.0",
        capabilities: { egress: ["warehouse.example.com"], packages: { pip: ["pandas"] } },
      },
    });
    // One run-less server call on the chosen model, under the member, with the skill as data.
    expect(gateway.calls).toHaveLength(1);
    const call = gateway.calls[0];
    expect(call?.claims).toMatchObject({
      purpose: "skill_manifest",
      team_id: team,
      user_id: builderId,
      model: "openai/glm-fake",
    });
    expect(call?.claims.run_id).toBeUndefined();
    expect(call?.claims.thread_id).toBeUndefined();
    expect(call?.body.model).toBe("openai/glm-fake");
    expect(call?.body.messages[1]?.content).toContain("Known tags: finance, sales");
    expect(call?.body.messages[1]?.content).toContain("- scripts/report.py");
    expect(call?.body.messages[1]?.content).toContain("Add a totals row.");
    // The ledger row the gateway wrote: the member's, kind skill_manifest, no run.
    const usage = await h.admin.query<{ kind: string; run_id: string | null; user_id: string }>(
      `SELECT kind, run_id, user_id FROM run_usage WHERE team_id = $1`,
      [team],
    );
    expect(usage.rows).toEqual([{ kind: "skill_manifest", run_id: null, user_id: builderId }]);

    // The draft holds the version's files and the manifest, at one revision; the file reads back.
    const draftId = res.json.draft.id as string;
    expect(await draftFiles(builder, draftId)).toEqual([
      "SKILL.md",
      "kobe.skill.yaml",
      "scripts/report.py",
    ]);
    const yaml = await builder.get(`/v1/skills/drafts/${draftId}/files/kobe.skill.yaml`);
    expect(yaml.status).toBe(200);
    expect(yaml.text).toContain("name: sales-report");
    expect(yaml.text).toContain(`version: ${v.semver}`);
    expect(yaml.text).toContain("license: Apache-2.0");
    expect(yaml.text).toContain("- warehouse.example.com");
    // The version itself is untouched (immutable): its preview still refuses.
    const again = await builder.get(
      `/v1/skills/promotions/preview?scope=team&skillId=${v.skillId}&version=${v.version}`,
    );
    expect((again.json.refusals as { code: string }[]).map((r) => r.code)).toContain("no_manifest");
    // Audited, metadata only.
    const audit = await h.admin.query<{ target: Record<string, unknown> }>(
      `SELECT target FROM audit_log WHERE team_id = $1 AND action = 'skill.manifest.generated'`,
      [team],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]?.target).toMatchObject({
      draftId,
      skillId: v.skillId,
      scope: "team",
      version: v.version,
      model: "glm",
      from: "model",
    });
    expect(JSON.stringify(audit.rows[0]?.target)).not.toContain("warehouse");
  });

  it("uses the team default without a model, and a reply with no JSON still gives a file from SKILL.md", async () => {
    gateway.reply = () => "I would rather not.";
    const v = await uploadTeam(builder, bare("seed-report"));
    const res = await builder.post("/v1/skills/promotions/manifest", {
      scope: "team",
      skillId: v.skillId,
      version: v.version,
    });
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    expect(res.json).toMatchObject({ model: "k2", source: "seed" });
    expect(res.json.manifest).toEqual({
      apiVersion: "kobe.dev/skill/v1",
      name: "seed-report",
      version: v.semver,
      summary: "Builds seed-report reports. Use when asked for a seed-report report.",
    });
    expect(gateway.calls[0]?.claims.model).toBe("openai/k2-fake");
  });

  it("refuses a version that has a manifest, a model the team does not enable, and a member who may not promote", async () => {
    const withManifest = await uploadTeam(builder, pkg("has-manifest", "1.0.0"));
    const has = await builder.post("/v1/skills/promotions/manifest", {
      scope: "team",
      skillId: withManifest.skillId,
      version: withManifest.version,
    });
    expect([has.status, has.json.code]).toEqual([409, "has_manifest"]);

    const v = await uploadTeam(builder, bare("refused-report"));
    const off = await builder.post("/v1/skills/promotions/manifest", {
      scope: "team",
      skillId: v.skillId,
      version: v.version,
      model: "off",
    });
    expect([off.status, off.json.code]).toEqual([422, "model_not_enabled"]);
    const unknown = await builder.post("/v1/skills/promotions/manifest", {
      scope: "team",
      skillId: v.skillId,
      version: v.version,
      model: "nope",
    });
    expect([unknown.status, unknown.json.code]).toEqual([422, "model_not_enabled"]);
    const asMember = await member.post("/v1/skills/promotions/manifest", {
      scope: "team",
      skillId: v.skillId,
      version: v.version,
    });
    expect([asMember.status, asMember.json.code]).toEqual([403, "forbidden"]);
    const missing = await builder.post("/v1/skills/promotions/manifest", {
      scope: "team",
      skillId: randomUUID(),
      version: 1,
    });
    expect([missing.status, missing.json.code]).toEqual([404, "not_found"]);
    expect(gateway.calls).toEqual([]);
    expect((await builder.get("/v1/skills/drafts")).json.drafts).not.toContainEqual(
      expect.objectContaining({ name: "refused-report" }),
    );
  });

  it("a gateway refusal is a 502 with its code, and no draft is made", async () => {
    gateway.reply = () => ({ status: 402, code: "budget_exhausted" });
    const v = await uploadTeam(builder, bare("broke-report"));
    const res = await builder.post("/v1/skills/promotions/manifest", {
      scope: "team",
      skillId: v.skillId,
      version: v.version,
    });
    expect([res.status, res.json.code, res.json.detail]).toEqual([
      502,
      "call_failed",
      "budget_exhausted",
    ]);
    expect((await builder.get("/v1/skills/drafts")).json.drafts).not.toContainEqual(
      expect.objectContaining({ name: "broke-report" }),
    );
  });
});

describe("POST /v1/skills/drafts/:id/manifest (KOBE-564)", () => {
  it("writes kobe.skill.yaml into an open draft at If-Match's revision, once", async () => {
    const started = await builder.post("/v1/skills/drafts", {
      name: "draft-report",
      template: "document-generator",
    });
    expect(started.status).toBe(201);
    const id = started.json.draft.id as string;
    const stale = await builder.request("POST", `/v1/skills/drafts/${id}/manifest`, {
      license: "MIT",
    });
    expect([stale.status, stale.json.code]).toEqual([428, "precondition_required"]);
    const res = await builder.request(
      "POST",
      `/v1/skills/drafts/${id}/manifest`,
      { license: "MIT" },
      { "If-Match": String(started.json.draft.rev) },
    );
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    expect(res.json).toMatchObject({
      rev: started.json.draft.rev + 1,
      model: "k2",
      source: "model",
    });
    expect(res.json.manifest).toMatchObject({
      name: "draft-report",
      version: "0.1.0",
      license: "MIT",
    });
    expect(await draftFiles(builder, id)).toContain("kobe.skill.yaml");
    const again = await builder.request(
      "POST",
      `/v1/skills/drafts/${id}/manifest`,
      {},
      { "If-Match": String(res.json.rev) },
    );
    expect([again.status, again.json.code]).toEqual([409, "has_manifest"]);
    const audit = await h.admin.query<{ target: Record<string, unknown> }>(
      `SELECT target FROM audit_log WHERE team_id = $1 AND action = 'skill.manifest.generated'
        AND target->>'draftId' = $2`,
      [team, id],
    );
    expect(audit.rows.map((r) => r.target)).toEqual([{ draftId: id, model: "k2", from: "model" }]);
  });
});
