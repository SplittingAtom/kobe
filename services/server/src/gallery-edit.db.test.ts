import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedGalleryAgents } from "./gallery/seed.js";
import type { GalleryDefinition } from "./gallery/definitions.js";
import type { TestBrowser, TestResponse } from "./testing/browser.js";
import { openHarness, type Harness } from "./testing/harness.js";

/**
 * Editing gallery agents (KOBE-494; D19/D21 as amended by Chris 2026-10-23): site admins save
 * drafts and publish gallery agents through the site routes; the first edit marks the agent
 * Customized and detaches it from the repository definition, which the seed then skips while
 * still recording the newer generation; Reset to repository re-attaches it.
 */
type Person = "admin" | "bob" | "carol";
const ids = {} as Record<Person, string>;
const as = {} as Record<Person, TestBrowser>;
const team = randomUUID();
let h: Harness;

const ANY = { "if-match": "*" };
const BASE = "/v1/site/gallery/agents";
const json = (res: TestResponse) => JSON.stringify(res.json);

const file = (prompt: string) =>
  `---\nname: Editable Analyst\ndescription: A fixture for gallery edits\nstarters: ["Hello"]\n---\n${prompt}\n`;
const V1: GalleryDefinition = { key: "editable-analyst", generation: 1, file: file("Repo v1.") };
const V2: GalleryDefinition = { ...V1, generation: 2, file: file("Repo v2.") };
const OTHER: GalleryDefinition = {
  key: "untouched-analyst",
  generation: 1,
  file: file("Left alone."),
};
const EDIT = {
  frontmatter: { name: "Editable Analyst", description: "Edited by the site" },
  prompt: "Customized by a site admin.",
};

const seed = (...definitions: GalleryDefinition[]) =>
  seedGalleryAgents(h.deps.database.db, definitions);

const audited = async (action: string, agentId: string) =>
  (
    await h.admin.query<{
      team_id: string | null;
      actor_id: string | null;
      target: Record<string, unknown>;
    }>(
      `SELECT team_id, actor_id, target FROM audit_log WHERE action = $1 AND target->>'agentId' = $2 ORDER BY seq`,
      [action, agentId],
    )
  ).rows;

const versions = async (agentId: string) =>
  (
    await h.admin.query<{ version: number; published_by: string | null; prompt: string }>(
      `SELECT version, published_by, prompt FROM site_agent_versions WHERE agent_id = $1 ORDER BY version`,
      [agentId],
    )
  ).rows;

const marker = async (agentId: string) =>
  (
    await h.admin.query<{
      customized_at: Date | null;
      customized_by: string | null;
      customized_from_generation: number | null;
      gallery_generation: number | null;
    }>(
      `SELECT customized_at, customized_by, customized_from_generation, gallery_generation FROM site_agents WHERE id = $1`,
      [agentId],
    )
  ).rows[0];

let agentId = "";
let otherId = "";

beforeAll(async () => {
  h = await openHarness();
  ids.admin = await h.createUser("admin@gallery-edit.test", "admin");
  ids.bob = await h.createUser("bob@gallery-edit.test");
  ids.carol = await h.createUser("carol@gallery-edit.test");
  await h.admin.query(`INSERT INTO teams (id, slug, name) VALUES ($1, 'ge-team', 'GE Team')`, [
    team,
  ]);
  for (const [who, role] of [
    ["admin", "team_admin"],
    ["bob", "builder"],
    ["carol", "member"],
  ] as const) {
    await h.admin.query(`INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, $3)`, [
      team,
      ids[who],
      role,
    ]);
  }
  for (const who of ["admin", "bob", "carol"] as const) {
    as[who] = await h.signIn(`${who}@gallery-edit.test`);
    const res = await as[who].put("/v1/me/teams/active", { teamId: team });
    expect(res.status, json(res)).toBe(200);
    as[who].team = team;
  }
  const [one, two] = await seed(V1, OTHER);
  agentId = one?.agentId ?? "";
  otherId = two?.agentId ?? "";
});

afterAll(async () => {
  await h?.close();
});

describe("site admins only (re-checked on every call)", () => {
  it("refuses draft save, publish, compare and reset to everyone else", async () => {
    for (const who of ["bob", "carol"] as const) {
      const results = await Promise.all([
        as[who].put(`${BASE}/${agentId}`, EDIT, ANY),
        as[who].request("POST", `${BASE}/${agentId}/publish`, {}, ANY),
        as[who].get(`${BASE}/${agentId}/compare`),
        as[who].post(`${BASE}/${agentId}/reset`),
        as[who].get(`${BASE}/${agentId}/versions`),
      ]);
      expect(
        results.map((r) => r.status),
        who,
      ).toEqual([403, 403, 403, 403, 403]);
    }
    expect((await marker(agentId))?.customized_at).toBeNull();
  });

  it("offers site admins the site's models and active connectors for the editor", async () => {
    const res = await as.admin.get(`${BASE}/builder-options`);
    expect(res.status, json(res)).toBe(200);
    expect(res.json.models).toMatchObject({ default: null });
    expect(Array.isArray(res.json.models.models)).toBe(true);
    expect(Array.isArray(res.json.connectors)).toBe(true);
    expect((await as.carol.get(`${BASE}/builder-options`)).status).toBe(403);
  });

  it("refuses a site admin demoted since sign-in", async () => {
    const demoted = await h.createUser("demoted@gallery-edit.test", "admin");
    const browser = await h.signIn("demoted@gallery-edit.test");
    await h.admin.query(`DELETE FROM site_roles WHERE user_id = $1`, [demoted]);
    expect((await browser.put(`${BASE}/${agentId}`, EDIT, ANY)).status).toBe(403);
  });

  it("keeps creating, deleting, suspending and unarchiving gallery agents closed", async () => {
    const results = await Promise.all([
      as.admin.post(BASE, EDIT),
      as.admin.delete(`${BASE}/${agentId}`),
      as.admin.put(`${BASE}/${agentId}/status`, { status: "suspended" }),
      as.admin.post(`${BASE}/${agentId}/unarchive`),
    ]);
    expect(results.map((r) => r.status)).toEqual([405, 405, 405, 405]);
  });
});

describe("edit, publish and the Customized marker (ac-2, ac-3)", () => {
  it("saves a draft, marks the agent Customized once and audits both at gallery scope", async () => {
    const saved = await as.admin.put(`${BASE}/${agentId}`, EDIT, ANY);
    expect(saved.status, json(saved)).toBe(200);
    expect(saved.json.agent).toMatchObject({
      prompt: "Customized by a site admin.",
      canEdit: true,
      canPublish: true,
      gallery: { customized: true, customizedFromGeneration: 1, updateAvailable: false },
    });
    const again = await as.admin.put(
      `${BASE}/${agentId}`,
      { ...EDIT, prompt: "Customized twice." },
      ANY,
    );
    expect(again.status, json(again)).toBe(200);
    const m = await marker(agentId);
    expect(m).toMatchObject({ customized_by: ids.admin, customized_from_generation: 1 });
    expect(m?.customized_at).not.toBeNull();
    const customized = await audited("agent.customized", agentId);
    expect(customized).toHaveLength(1);
    expect(customized[0]).toMatchObject({
      team_id: null,
      actor_id: ids.admin,
      target: { scope: "gallery", slug: V1.key, fromGeneration: 1 },
    });
    const updates = await audited("agent.updated", agentId);
    expect(updates.at(-1)?.target).toMatchObject({ scope: "gallery", source: "json" });
  });

  it("checks If-Match: a stale revision is refused", async () => {
    const res = await as.admin.put(`${BASE}/${agentId}`, EDIT, { "if-match": '"1"' });
    expect(res.status).toBe(412);
  });

  it("publishes a new immutable version by the site admin, audited at gallery scope", async () => {
    const res = await as.admin.request("POST", `${BASE}/${agentId}/publish`, {}, ANY);
    expect(res.status, json(res)).toBe(201);
    expect(res.json.version.version).toBe(2);
    expect(await versions(agentId)).toEqual([
      { version: 1, published_by: null, prompt: "Repo v1." },
      { version: 2, published_by: ids.admin, prompt: "Customized twice." },
    ]);
    const published = await audited("agent.published", agentId);
    expect(published.at(-1)).toMatchObject({
      team_id: null,
      actor_id: ids.admin,
      target: { scope: "gallery", version: 2 },
    });
    const history = await as.admin.get(`${BASE}/${agentId}/versions`);
    expect(history.json.versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
  });

  it("gives teams that fork it the customized version", async () => {
    const fork = await as.bob.post(`/v1/agents/${agentId}/fork`, { scope: "team" });
    expect(fork.status, json(fork)).toBe(201);
    expect(fork.json.agent).toMatchObject({
      prompt: "Customized twice.",
      forkedFrom: { agentId, version: 2 },
    });
  });

  it("is never overwritten by the seed, which records the newer generation (skipped_customized)", async () => {
    const results = await seed(V2, OTHER);
    expect(results.map((r) => r.action)).toEqual(["skipped_customized", "unchanged"]);
    expect((await versions(agentId)).map((v) => v.version)).toEqual([1, 2]);
    expect(await marker(agentId)).toMatchObject({
      gallery_generation: 2,
      customized_from_generation: 1,
    });
    const list = await as.admin.get(BASE);
    const row = list.json.agents.find((a: { id: string }) => a.id === agentId);
    expect(row.gallery).toMatchObject({
      customized: true,
      generation: 2,
      customizedFromGeneration: 1,
      updateAvailable: true,
    });
    const other = list.json.agents.find((a: { id: string }) => a.id === otherId);
    expect(other.gallery).toMatchObject({ customized: false, updateAvailable: false });
    // An older replica never lowers the recorded generation.
    expect((await seed(V1, OTHER))[0]?.action).toBe("skipped_customized");
    expect((await marker(agentId))?.gallery_generation).toBe(2);
  });

  it("compares the repository definition with the current version", async () => {
    const res = await as.admin.get(`${BASE}/${agentId}/compare`);
    expect(res.status, json(res)).toBe(200);
    expect(res.json).toMatchObject({
      repository: { generation: 2 },
      current: { version: 2, prompt: "Customized twice." },
    });
    expect(res.json.repository.prompt.trim()).toBe("Repo v2.");
    expect(res.json.repository.file).toMatch(/^---\nname: Editable Analyst\n/);
    expect(res.json.current.file).toMatch(/Customized twice\./);
  });
});

describe("Reset to repository (ac-4)", () => {
  it("refuses an agent that is not customized", async () => {
    const res = await as.admin.post(`${BASE}/${otherId}/reset`);
    expect(res.status).toBe(409);
    expect(res.json.code).toBe("not_customized");
  });

  it("re-attaches the agent and publishes the repository definition as a new version", async () => {
    const res = await as.admin.post(`${BASE}/${agentId}/reset`);
    expect(res.status, json(res)).toBe(200);
    expect(res.json.agent).toMatchObject({
      currentVersion: 3,
      gallery: { customized: false, updateAvailable: false },
    });
    expect(await marker(agentId)).toMatchObject({
      customized_at: null,
      customized_by: null,
      customized_from_generation: null,
      gallery_generation: 2,
    });
    const all = await versions(agentId);
    expect(all.at(-1)).toMatchObject({ version: 3, published_by: null });
    expect(all.at(-1)?.prompt.trim()).toBe("Repo v2.");
    expect(await audited("agent.reset_to_repository", agentId)).toMatchObject([
      { team_id: null, actor_id: ids.admin, target: { scope: "gallery", fromGeneration: 1 } },
    ]);
    // Attached again: the next start changes nothing, a newer release publishes again.
    expect((await seed(V2, OTHER))[0]?.action).toBe("unchanged");
    expect((await seed({ ...V2, generation: 3, file: file("Repo v3.") }, OTHER))[0]?.action).toBe(
      "updated",
    );
  });

  it("leaves archived agents as they are (no edit)", async () => {
    await h.admin.query(`UPDATE site_agents SET archived_at = now() WHERE id = $1`, [otherId]);
    const res = await as.admin.put(`${BASE}/${otherId}`, EDIT, ANY);
    expect(res.status).toBe(409);
    expect((await marker(otherId))?.customized_at).toBeNull();
  });
});
