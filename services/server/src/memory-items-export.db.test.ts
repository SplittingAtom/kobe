import { randomUUID } from "node:crypto";
import { strFromU8, unzipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { semanticMemoryItemDetailSchema, type SemanticMemoryScope } from "@kobe/protocol";
import type { TestBrowser } from "./testing/browser.js";
import { openHarness, type Harness } from "./testing/harness.js";
import type { ExportedItem } from "./memory/items-export.js";

/**
 * KOBE-649 (v1.3 SMA11d, SM28): the personal export holds the person's own semantic memories,
 * their `user` items in the exported Workspace and their portable items, with versions (ac-1);
 * never Workspace (`team`) or Site items, another person's items or quotes of anyone else's
 * messages (ac-2); the export's audit counts them (ac-3).
 */
let h: Harness;
const teamA = randomUUID();
const teamB = randomUUID();
const ids = { site: "", admin: "", member: "", other: "" };
const as = {} as Record<keyof typeof ids, TestBrowser>;
const ITEMS = "/v1/memory/semantic/items";

const save = async (
  who: TestBrowser,
  scope: SemanticMemoryScope,
  statement: string,
  extra: Record<string, unknown> = {},
) => {
  const res = await who.post(ITEMS, {
    scope,
    kind: scope === "portable" ? "preference" : "fact",
    statement,
    ...(scope === "portable" ? { confirm_portable: true } : {}),
    ...extra,
  });
  expect(res.status, JSON.stringify(res.json)).toBe(201);
  return semanticMemoryItemDetailSchema.parse(res.json);
};

async function download(b: TestBrowser, team: string) {
  const res = await h.app.request(`http://kobe.test/v1/threads/export?team=${team}`, {
    headers: {
      origin: "http://kobe.test",
      "x-forwarded-for": b.ip,
      cookie: [...b.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
    },
  });
  expect(res.status).toBe(200);
  const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
  const raw = strFromU8(files["memory-items.json"] ?? new Uint8Array());
  return { raw, items: (JSON.parse(raw) as { items: ExportedItem[] }).items };
}

const thread = async (owner: string, shared = false) =>
  (
    await h.admin.query<{ id: string }>(
      `INSERT INTO threads (team_id, owner_user_id, title, shared_to_team)
       VALUES ($1, $2, 'T', $3) RETURNING id`,
      [teamA, owner, shared],
    )
  ).rows[0]?.id ?? "";

const entry = (threadId: string, entryId: string, role: "user" | "assistant", text: string) =>
  h.admin.query(
    `INSERT INTO thread_entries (team_id, thread_id, entry_id, parent_id, type, payload)
     VALUES ($1, $2, $3, NULL, 'message', $4)`,
    [
      teamA,
      threadId,
      entryId,
      JSON.stringify({
        type: "message",
        id: entryId,
        message: { role, content: role === "user" ? text : [{ type: "text", text }] },
      }),
    ],
  );

/** A learning pass's version with evidence (KOBE-389 writes these; no API yet). */
async function passVersion(
  itemId: string,
  version: number,
  statement: string,
  threadId: string,
  evidence: unknown,
) {
  await h.admin.query("BEGIN");
  await h.admin.query(
    `INSERT INTO semantic_memory_item_versions
       (team_id, item_id, version, statement, actor_user_id, actor_kind, pass_id,
        source_thread_id, source_entry_ids, evidence)
     VALUES ($1, $2, $3, $4, $5, 'pass', $6, $7, ARRAY['m1'], $8)`,
    [
      teamA,
      itemId,
      version,
      statement,
      ids.member,
      randomUUID(),
      threadId,
      JSON.stringify(evidence),
    ],
  );
  await h.admin.query(
    `UPDATE semantic_memory_items SET current_version = $3, updated_at = now()
      WHERE team_id = $1 AND id = $2`,
    [teamA, itemId, version],
  );
  await h.admin.query("COMMIT");
}

beforeAll(async () => {
  h = await openHarness();
  ids.site = await h.createUser("site@export-items.test", "admin");
  for (const who of ["admin", "member", "other"] as const)
    ids[who] = await h.createUser(`${who}@export-items.test`);
  await h.admin.query(
    `INSERT INTO teams (id, slug, name) VALUES ($1, 'xi-a', 'A'), ($2, 'xi-b', 'B')`,
    [teamA, teamB],
  );
  await h.admin.query(
    `INSERT INTO team_members (team_id, user_id, role) VALUES
       ($1, $3, 'member'), ($1, $4, 'team_admin'), ($1, $5, 'member'), ($1, $6, 'member'),
       ($2, $5, 'member')`,
    [teamA, teamB, ids.site, ids.admin, ids.member, ids.other],
  );
  for (const who of Object.keys(ids) as (keyof typeof ids)[]) {
    as[who] = await h.signIn(`${who}@export-items.test`);
    await as[who].put("/v1/me/teams/active", { teamId: teamA });
    as[who].team = teamA;
  }
});

afterAll(async () => {
  await h?.close();
});

describe("semantic memories in the personal export (KOBE-649)", () => {
  it("holds the person's Workspace and portable items with versions, and nothing else", async () => {
    // The person's own items: a fact edited twice and archived, a portable preference.
    const fact = await save(as.member, "user", "Our fiscal year starts in April", {
      tags: ["finance"],
    });
    const edited = await as.member.patch(`${ITEMS}/user/${fact.id}`, {
      expected_version: 1,
      statement: "Our fiscal year starts on 1 April",
    });
    expect(edited.status, JSON.stringify(edited.json)).toBe(200);
    expect((await as.member.post(`${ITEMS}/user/${fact.id}/archive`, {})).status).toBe(200);
    const pref = await save(as.member, "portable", "Answer in British English");

    // Excluded: another person's items, the Workspace's and the Site's items, and the person's
    // own item in another Workspace.
    await save(as.other, "user", "OTHER-PERSON item text");
    await save(as.other, "portable", "OTHER-PERSON portable text");
    await save(as.admin, "team", "WORKSPACE-SCOPE shared item");
    await save(as.site, "site", "SITE-SCOPE item");
    await as.member.put("/v1/me/teams/active", { teamId: teamB });
    as.member.team = teamB;
    await save(as.member, "user", "TEAM-B item of the member");
    await as.member.put("/v1/me/teams/active", { teamId: teamA });
    as.member.team = teamA;

    const { raw, items } = await download(as.member, teamA);
    const byId = new Map(items.map((i) => [i.id, i]));
    expect([...byId.keys()].sort()).toEqual([fact.id, pref.id].sort());
    for (const text of ["OTHER-PERSON", "WORKSPACE-SCOPE", "SITE-SCOPE", "TEAM-B"])
      expect(raw).not.toContain(text);

    expect(byId.get(fact.id)).toMatchObject({
      scope: "user",
      kind: "fact",
      status: "archived",
      statement: "Our fiscal year starts on 1 April",
      tags: ["finance"],
      version: 2,
      created_at: expect.any(String),
      updated_at: expect.any(String),
    });
    expect(byId.get(fact.id)?.versions.map((v) => [v.version, v.statement])).toEqual([
      [1, "Our fiscal year starts in April"],
      [2, "Our fiscal year starts on 1 April"],
    ]);
    expect(byId.get(pref.id)).toMatchObject({
      scope: "portable",
      kind: "preference",
      statement: "Answer in British English",
      versions: [{ version: 1, statement: "Answer in British English", evidence: [] }],
    });

    // Portable items follow the person: their export from another Workspace holds them too.
    as.member.team = teamB;
    await as.member.put("/v1/me/teams/active", { teamId: teamB });
    const fromB = await download(as.member, teamB);
    expect(fromB.items.map((i) => i.statement).sort()).toEqual(
      ["Answer in British English", "TEAM-B item of the member"].sort(),
    );
    await as.member.put("/v1/me/teams/active", { teamId: teamA });
    as.member.team = teamA;

    // The other person's export holds only theirs.
    const theirs = await download(as.other, teamA);
    expect(theirs.items.map((i) => i.statement).sort()).toEqual(
      ["OTHER-PERSON item text", "OTHER-PERSON portable text"].sort(),
    );
  });

  it("keeps evidence quotes only from the person's own messages", async () => {
    const mine = await thread(ids.member);
    await entry(mine, "m1", "user", "We close the books on the fifth working day");
    await entry(mine, "m2", "assistant", "ASSISTANT words about the books");
    const sharedTheirs = await thread(ids.other, true);
    await entry(sharedTheirs, "o1", "user", "OTHER-PERSON message in a shared thread");

    const own = await save(as.member, "user", "Books close on the fifth working day", {
      source_thread_id: mine,
      source_entry_ids: ["m1"],
    });
    await passVersion(own.id, 2, "Books close on working day five", mine, [
      { entry_id: "m1", quote: "close the books on the fifth working day" },
      { entry_id: "m2", quote: "ASSISTANT words" },
      { entry_id: "missing", quote: "NO-SUCH-ENTRY quote" },
      { entry_id: "m1", thread_id: sharedTheirs, quote: "WRONG-THREAD quote" },
    ]);
    const fromShared = await save(as.member, "user", "Shared-thread learning", {
      source_thread_id: sharedTheirs,
    });
    await passVersion(fromShared.id, 2, "Shared-thread learning, refined", sharedTheirs, {
      quotes: [{ entry_id: "o1", quote: "OTHER-PERSON message" }],
    });

    const { raw, items } = await download(as.member, teamA);
    for (const text of ["ASSISTANT", "OTHER-PERSON", "NO-SUCH-ENTRY", "WRONG-THREAD"])
      expect(raw).not.toContain(text);
    const versions = items.find((i) => i.id === own.id)?.versions ?? [];
    expect(versions.map((v) => [v.version, v.actor_kind, v.source_thread_id])).toEqual([
      [1, "user", mine],
      [2, "pass", mine],
    ]);
    expect(versions[1]?.evidence).toEqual([
      { entry_id: "m1", quote: "close the books on the fifth working day" },
    ]);
    const shared = items.find((i) => i.id === fromShared.id);
    expect(shared?.versions.at(-1)).toMatchObject({ source_thread_id: sharedTheirs, evidence: [] });
  });

  it("is audited with the number of memories, without their text", async () => {
    // The other person owns one thread (the shared one, one entry) and two memories.
    const before = await h.admin.query(`SELECT max(seq) AS seq FROM audit_log`);
    await download(as.other, teamA);
    const { rows } = await h.admin.query<{ actor_id: string; target: Record<string, unknown> }>(
      `SELECT actor_id, target FROM audit_log WHERE action = 'thread.exported' AND seq > $1`,
      [before.rows[0]?.seq ?? 0],
    );
    expect(rows).toEqual([
      { actor_id: ids.other, target: { threads: 1, entries: 1, memoryItems: 2 } },
    ]);
  });
});
