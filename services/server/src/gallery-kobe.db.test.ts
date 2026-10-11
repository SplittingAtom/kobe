import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GALLERY_DEFINITIONS, type GalleryDefinition } from "./gallery/definitions.js";
import { seedGalleryAgents } from "./gallery/seed.js";
import type { TestBrowser } from "./testing/browser.js";
import { openHarness, type Harness } from "./testing/harness.js";

/**
 * KOBE-254: the gallery is one agent, Kobe. A fresh install seeds only Kobe; an install upgraded
 * from the five-agent gallery (KOBE-89) archives those five (soft, audited as the system), never
 * deletes or revives them, and keeps their threads readable.
 */
let h: Harness;
let carol: TestBrowser;
const team = randomUUID();

/** The five gallery keys before KOBE-254: upgrade fixtures only. */
const RETIRED_KEYS = ["assistant", "data-analyst", "researcher", "document-drafter", "code-helper"];
const OLD_GALLERY: GalleryDefinition[] = RETIRED_KEYS.map((key) => ({
  key,
  generation: 3,
  file: `---\nname: Old ${key}\ndescription: A pre-KOBE-254 gallery agent\n---\nYou are ${key}.\n`,
}));

const seed = (definitions: readonly GalleryDefinition[] = GALLERY_DEFINITIONS) =>
  seedGalleryAgents(h.deps.database.db, definitions);

const galleryRows = async () =>
  (
    await h.admin.query<{
      id: string;
      gallery_key: string;
      archived_at: Date | null;
      archived_by: string | null;
      current_version: number | null;
    }>(
      `SELECT id, gallery_key, archived_at, archived_by, current_version
         FROM install_agents WHERE scope = 'gallery' ORDER BY gallery_key`,
    )
  ).rows;

const listedSlugs = async () =>
  (await carol.get("/v1/agents?scope=gallery")).json.agents.map((a: { slug: string }) => a.slug);

const auditCount = async (action: string, agentId: string) =>
  (
    await h.admin.query<{ actor_kind: string; team_id: string | null }>(
      `SELECT actor_kind, team_id FROM audit_log WHERE action = $1 AND target->>'agentId' = $2`,
      [action, agentId],
    )
  ).rows;

beforeAll(async () => {
  h = await openHarness();
  const id = await h.createUser("carol@kobe-gallery.test");
  await h.admin.query(`INSERT INTO teams (id, slug, name) VALUES ($1, 'ops', 'Ops')`, [team]);
  await h.admin.query(
    `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'member')`,
    [team, id],
  );
  carol = await h.signIn("carol@kobe-gallery.test");
  expect((await carol.put("/v1/me/teams/active", { teamId: team })).status).toBe(200);
  carol.team = team;
});

afterAll(async () => {
  await h?.close();
});

describe("the one gallery agent (KOBE-254)", () => {
  it("ac-1: a fresh install seeds exactly Kobe, published, with every tool and `all` connectors", async () => {
    expect(await seed()).toEqual([expect.objectContaining({ key: "kobe", action: "created" })]);
    const rows = await galleryRows();
    expect(rows.map((r) => [r.gallery_key, r.current_version, r.archived_at])).toEqual([
      ["kobe", 1, null],
    ]);
    expect(await listedSlugs()).toEqual(["kobe"]);
    const kobeId = rows[0]?.id ?? "";
    const one = await carol.get(`/v1/agents/${kobeId}`);
    expect(one.json.agent).toMatchObject({ scope: "gallery", name: "Kobe", currentVersion: 1 });
    const { rows: versions } = await h.admin.query<{
      frontmatter: Record<string, unknown>;
      tool_manifest: { connectors: unknown; excluded: { reason: string }[] };
    }>(`SELECT frontmatter, tool_manifest FROM install_agent_versions WHERE agent_id = $1`, [
      kobeId,
    ]);
    expect(versions).toHaveLength(1);
    expect(versions[0]?.frontmatter).toMatchObject({ name: "Kobe", connectors: "all" });
    expect(versions[0]?.frontmatter).not.toHaveProperty("tools");
    expect(versions[0]?.tool_manifest.connectors).toBe("all");
    for (const e of versions[0]?.tool_manifest.excluded ?? []) expect(e.reason).toBe("unavailable");
    // New chats can start with it in every team.
    expect((await carol.post("/v1/threads", { agent_id: kobeId })).status).toBe(201);
  });

  it("ac-2: an upgrade archives the five old agents, keeps their threads, never revives them", async () => {
    // The install as a pre-KOBE-254 release left it: the five, each with a thread.
    await seed([...GALLERY_DEFINITIONS, ...OLD_GALLERY]);
    const before = await galleryRows();
    const old = before.filter((r) => RETIRED_KEYS.includes(r.gallery_key));
    expect(old).toHaveLength(5);
    const threads = new Map<string, string>();
    for (const r of old) {
      const t = await carol.post("/v1/threads", { agent_id: r.id });
      expect(t.status).toBe(201);
      threads.set(r.id, t.json.thread_id as string);
    }
    // An old row that never got a version (an interrupted seed): archived as well, never deleted.
    const { rows: drafted } = await h.admin.query<{ id: string }>(
      `INSERT INTO install_agents (scope, slug, gallery_key, gallery_generation, frontmatter, prompt)
       VALUES ('gallery', 'unpublished-old', 'unpublished-old', 1, '{"name":"Draft"}', 'x') RETURNING id`,
    );
    const draftId = drafted[0]?.id ?? "";

    // The upgrade, then two more restarts: same outcome each time.
    for (let restart = 0; restart < 3; restart += 1) {
      expect(await seed()).toEqual([expect.objectContaining({ key: "kobe", action: "unchanged" })]);
      const rows = await galleryRows();
      expect(rows).toHaveLength(7);
      for (const r of rows.filter((x) => x.gallery_key !== "kobe")) {
        expect(r.archived_at, r.gallery_key).not.toBeNull();
        expect(r.archived_by, r.gallery_key).toBe("seed");
      }
      expect(rows.find((r) => r.gallery_key === "kobe")?.archived_at).toBeNull();
      expect(await listedSlugs()).toEqual(["kobe"]);
    }
    for (const r of [...old, { id: draftId }]) {
      expect(await auditCount("agent.archived", r.id)).toEqual([
        { actor_kind: "system", team_id: null },
      ]);
      expect(await auditCount("agent.deleted", r.id)).toEqual([]);
      expect(await auditCount("agent.unarchived", r.id)).toEqual([]);
    }
    // Their threads stay readable, pinned to the old version; no new thread can start on them.
    for (const r of old) {
      const id = threads.get(r.id) ?? "";
      const thread = await carol.get(`/v1/threads/${id}`);
      expect(thread.status).toBe(200);
      expect(thread.json).toMatchObject({ agent_id: r.id, agent_version: r.current_version });
      expect((await carol.get(`/v1/threads/${id}/entries`)).status).toBe(200);
      expect((await carol.post("/v1/threads", { agent_id: r.id })).status).toBe(409);
    }
  });
});
