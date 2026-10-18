import { randomUUID } from "node:crypto";
import { withTeam } from "@kobe/db";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { purgeDepartedDraftsInTx } from "./retention/skill-drafts.js";
import { runRetentionPass } from "./retention/index.js";
import { RawBody, type TestBrowser } from "./testing/browser.js";
import { openHarness, type Harness } from "./testing/harness.js";
import { MemoryObjects } from "./testing/memory-objects.js";

/**
 * Workbench drafts (KOBE-320, SK11): owned by (author, team), private until shared with the team's
 * Builders and Team admins, every change revision-checked (a stale one is refused with who changed
 * it); Save version builds the package through upload validation and the scan, to the team (D22
 * review) or the author's personal skills (confirmed and audited when started from a
 * conversation); drafts follow team retention and offboarding.
 */
const team = randomUUID();
const otherTeam = randomUUID();
const objects = new MemoryObjects();
let h: Harness;
let author: TestBrowser;
let builder: TestBrowser;
let admin: TestBrowser;
let member: TestBrowser;
let authorId: string;
let builderId: string;

const skillMd = (name: string, body = "Body.") =>
  `---\nname: ${name}\ndescription: Does ${name} things. Use when asked about ${name}.\n---\n# ${name}\n${body}\n`;
const text = (s: string) => new RawBody(s, "text/plain; charset=utf-8");
const ifMatch = (rev: number) => ({ "if-match": `"${rev}"` });

async function create(who: TestBrowser, name: string) {
  const res = await who.post("/v1/skills/drafts", { name });
  expect(res.status, JSON.stringify(res.json)).toBe(201);
  return res.json.draft as { id: string; rev: number; name: string; shared: boolean };
}

async function write(who: TestBrowser, id: string, path: string, rev: number, body: RawBody) {
  return who.request("PUT", `/v1/skills/drafts/${id}/files/${path}`, body, ifMatch(rev));
}

beforeAll(async () => {
  h = await openHarness({ blobs: { objects, prefix: "kobe/" } });
  authorId = await h.createUser("author@drafts.test");
  builderId = await h.createUser("builder@drafts.test");
  const adminId = await h.createUser("admin@drafts.test");
  const memberId = await h.createUser("member@drafts.test");
  await h.admin.query(
    `INSERT INTO teams (id, slug, name) VALUES ($1, 'drafts', 'Finance'), ($2, 'drafts-2', 'Other')`,
    [team, otherTeam],
  );
  await h.admin.query(
    `INSERT INTO team_members (team_id, user_id, role) VALUES
       ($1, $2, 'member'), ($1, $3, 'builder'), ($1, $4, 'team_admin'), ($1, $5, 'member'),
       ($6, $2, 'member')`,
    [team, authorId, builderId, adminId, memberId, otherTeam],
  );
  author = await h.signIn("author@drafts.test");
  builder = await h.signIn("builder@drafts.test");
  admin = await h.signIn("admin@drafts.test");
  member = await h.signIn("member@drafts.test");
  for (const who of [author, builder, admin, member]) {
    expect((await who.put("/v1/me/teams/active", { teamId: team })).status).toBe(200);
    who.team = team;
  }
});

afterAll(async () => {
  await h?.close();
});

describe("drafts: create, read, write (ac-1)", () => {
  it("creates a private draft with a SKILL.md skeleton, listed for its author only", async () => {
    const draft = await create(author, "report-helper");
    expect(draft).toMatchObject({ name: "report-helper", shared: false, rev: 1 });
    const mine = await author.get("/v1/skills/drafts");
    expect(mine.json.drafts.map((d: { id: string }) => d.id)).toContain(draft.id);
    for (const other of [builder, admin, member]) {
      const list = await other.get("/v1/skills/drafts");
      expect(list.json.drafts.map((d: { id: string }) => d.id)).not.toContain(draft.id);
      expect((await other.get(`/v1/skills/drafts/${draft.id}`)).status).toBe(404);
    }
    const read = await author.get(`/v1/skills/drafts/${draft.id}`);
    expect(read.json.files).toEqual([
      expect.objectContaining({ path: "SKILL.md", kind: "text", size: expect.any(Number) }),
    ]);
    const file = await author.get(`/v1/skills/drafts/${draft.id}/files/SKILL.md`);
    expect(file.status).toBe(200);
    expect(file.headers.get("etag")).toBe('"1"');
    expect(file.text).toContain("name: report-helper");
  });

  it("refuses a bad name and caps drafts per author", async () => {
    expect((await author.post("/v1/skills/drafts", { name: "Bad Name" })).status).toBe(400);
    expect((await author.post("/v1/skills/drafts", {})).status).toBe(400);
  });

  it("writes text and binary files under a revision check; a stale write names who changed it", async () => {
    const draft = await create(author, "rev-check");
    const missing = await author.request(
      "PUT",
      `/v1/skills/drafts/${draft.id}/files/notes.md`,
      text("x"),
    );
    expect(missing.status).toBe(428);
    const first = await write(author, draft.id, "references/notes.md", 1, text("héllo"));
    expect(first.status, JSON.stringify(first.json)).toBe(200);
    expect(first.json.rev).toBe(2);
    const bin = await write(
      author,
      draft.id,
      "assets/logo.png",
      2,
      new RawBody(new Uint8Array([0x89, 0x50, 0x00, 0xff]), "application/octet-stream"),
    );
    expect(bin.json.rev).toBe(3);
    const stale = await write(author, draft.id, "references/notes.md", 2, text("late"));
    expect(stale.status).toBe(409);
    expect(stale.json).toMatchObject({
      code: "stale_revision",
      rev: 3,
      changedBy: { id: authorId, name: expect.any(String) },
    });
    const got = await author.get(`/v1/skills/drafts/${draft.id}/files/assets/logo.png`);
    expect(got.headers.get("content-type")).toBe("application/octet-stream");
    expect([...got.bytes]).toEqual([0x89, 0x50, 0x00, 0xff]);
    const notes = await author.get(`/v1/skills/drafts/${draft.id}/files/references/notes.md`);
    expect(notes.text).toBe("héllo");
    const files = (await author.get(`/v1/skills/drafts/${draft.id}`)).json;
    expect(files.draft).toMatchObject({ rev: 3, fileCount: 3 });
    expect(files.files.find((f: { path: string }) => f.path === "assets/logo.png")).toMatchObject({
      kind: "binary",
      size: 4,
    });
    const del = await author.request(
      "DELETE",
      `/v1/skills/drafts/${draft.id}/files/assets/logo.png`,
      undefined,
      ifMatch(3),
    );
    expect(del.status).toBe(200);
    expect(del.json.rev).toBe(4);
    expect((await author.get(`/v1/skills/drafts/${draft.id}/files/assets/logo.png`)).status).toBe(
      404,
    );
  });

  it("follows the SKILL.md name, and refuses unsafe, reserved or clashing paths", async () => {
    const draft = await create(author, "renamed-later");
    const res = await write(author, draft.id, "SKILL.md", 1, text(skillMd("renamed-now")));
    expect(res.json.draft.name).toBe("renamed-now");
    let rev = res.json.rev as number;
    for (const path of [
      "..%2Fx",
      "a/%00b",
      "provenance.json",
      "Evals/cases.yaml",
      "skill.md",
      "evals",
      "SKILL.md/x",
      "%E2%80%AEx",
    ]) {
      const bad = await write(author, draft.id, path, rev, text("x"));
      expect(bad.status, path).toBe(400);
      expect(bad.json.code, path).toBe("invalid_path");
    }
    const ok = await write(author, draft.id, "evals/cases.yaml", rev, text("cases: []\n"));
    expect(ok.status).toBe(200);
    rev = ok.json.rev;
    const clash = await write(author, draft.id, "EVALS/other.yaml", rev, text("x"));
    expect(clash.status).toBe(400);
  });

  it("caps a draft at 5 MiB in all and SKILL.md at its upload limit", async () => {
    const draft = await create(author, "big-draft");
    const big = new Uint8Array(3 * 1024 * 1024).fill(1);
    const one = await write(
      author,
      draft.id,
      "assets/a.bin",
      1,
      new RawBody(big, "application/octet-stream"),
    );
    expect(one.status).toBe(200);
    const two = await write(
      author,
      draft.id,
      "assets/b.bin",
      2,
      new RawBody(big, "application/octet-stream"),
    );
    expect(two.status).toBe(413);
    expect(two.json.code).toBe("draft_too_large");
    const md = await write(author, draft.id, "SKILL.md", 2, text("x".repeat(101 * 1024)));
    expect(md.status).toBe(413);
  });

  it("shares with Builders and Team admins only; only the author shares, unshares or deletes", async () => {
    const draft = await create(author, "shared-one");
    expect(
      (
        await builder.request(
          "PATCH",
          `/v1/skills/drafts/${draft.id}`,
          { shared: true },
          ifMatch(1),
        )
      ).status,
    ).toBe(404);
    const shared = await author.request(
      "PATCH",
      `/v1/skills/drafts/${draft.id}`,
      { shared: true },
      ifMatch(1),
    );
    expect(shared.status, JSON.stringify(shared.json)).toBe(200);
    expect(shared.json.draft).toMatchObject({ shared: true, rev: 2 });
    expect((await member.get(`/v1/skills/drafts/${draft.id}`)).status).toBe(404);
    const list = await builder.get("/v1/skills/drafts");
    expect(list.json.drafts.find((d: { id: string }) => d.id === draft.id)).toMatchObject({
      shared: true,
      mine: false,
    });
    const edit = await write(builder, draft.id, "references/b.md", 2, text("by builder"));
    expect(edit.status).toBe(200);
    const stale = await write(author, draft.id, "references/a.md", 2, text("late"));
    expect(stale.json.changedBy.id).toBe(builderId);
    expect((await admin.get(`/v1/skills/drafts/${draft.id}`)).status).toBe(200);
    expect(
      (
        await builder.request(
          "PATCH",
          `/v1/skills/drafts/${draft.id}`,
          { shared: false },
          ifMatch(3),
        )
      ).status,
    ).toBe(403);
    expect((await builder.delete(`/v1/skills/drafts/${draft.id}`)).status).toBe(403);
    expect((await author.delete(`/v1/skills/drafts/${draft.id}`)).status).toBe(204);
    expect((await author.get(`/v1/skills/drafts/${draft.id}`)).status).toBe(404);
    const audit = await h.admin.query<{ action: string }>(
      `SELECT action FROM audit_log WHERE team_id = $1 AND target ->> 'draftId' = $2 ORDER BY seq`,
      [team, draft.id],
    );
    expect(audit.rows.map((r) => r.action)).toEqual([
      "skill.draft.created",
      "skill.draft.shared",
      "skill.draft.deleted",
    ]);
  });

  it("keeps a team's drafts in that team", async () => {
    const draft = await create(author, "team-bound");
    author.team = otherTeam;
    expect((await author.put("/v1/me/teams/active", { teamId: otherTeam })).status).toBe(200);
    try {
      expect((await author.get(`/v1/skills/drafts/${draft.id}`)).status).toBe(404);
      const list = await author.get("/v1/skills/drafts");
      expect(list.json.drafts.map((d: { id: string }) => d.id)).not.toContain(draft.id);
      expect((await write(author, draft.id, "x.md", 1, text("x"))).status).toBe(404);
    } finally {
      expect((await author.put("/v1/me/teams/active", { teamId: team })).status).toBe(200);
      author.team = team;
    }
  });
});

describe("save version (ac-2)", () => {
  async function draftWith(who: TestBrowser, name: string) {
    const draft = await create(who, name);
    const res = await write(who, draft.id, "SKILL.md", 1, text(skillMd(name)));
    expect(res.status).toBe(200);
    return { id: draft.id, rev: res.json.rev as number };
  }

  const save = (who: TestBrowser, id: string, body: Record<string, unknown>, rev?: number) =>
    who.request(
      "POST",
      `/v1/skills/drafts/${id}/versions`,
      body,
      rev === undefined ? {} : ifMatch(rev),
    );

  it("saves to the team as a pending version (D22 review), audited with the draft", async () => {
    const d = await draftWith(builder, "team-saved");
    const res = await save(
      builder,
      d.id,
      {
        destination: "team",
        semver: "1.0.0",
        changelog: "First version.",
      },
      d.rev,
    );
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    expect(res.json.skill).toMatchObject({ scope: "team", slug: "team-saved" });
    expect(res.json.version).toMatchObject({
      semver: "1.0.0",
      changelog: "First version.",
      review: { status: "pending" },
    });
    const review = await h.admin.query<{ status: string }>(
      `SELECT status FROM team_skill_reviews WHERE team_id = $1 AND skill_id = $2`,
      [team, res.json.skill.id],
    );
    expect(review.rows).toEqual([{ status: "pending" }]);
    const audit = await h.admin.query<{ target: Record<string, unknown> }>(
      `SELECT target FROM audit_log WHERE action = 'skill.uploaded' AND target ->> 'skillId' = $1`,
      [res.json.skill.id],
    );
    expect(audit.rows[0]?.target).toMatchObject({ draftId: d.id, semver: "1.0.0" });
    // The draft stays for the next version; an unchanged one is refused.
    const again = await save(builder, d.id, {
      destination: "team",
      semver: "1.0.1",
      changelog: "Same.",
    });
    expect(again.status).toBe(409);
    expect(again.json.code).toBe("unchanged");
  });

  it("refuses a team save to a plain member, a stale revision and an invalid package", async () => {
    const d = await draftWith(author, "member-draft");
    const body = { destination: "team", semver: "1.0.0", changelog: "x" };
    expect((await save(author, d.id, body)).status).toBe(403);
    expect((await save(author, d.id, { ...body, destination: "personal" }, d.rev - 1)).status).toBe(
      409,
    );
    const bad = await create(author, "bad-package");
    await write(author, bad.id, "SKILL.md", 1, text("no frontmatter"));
    const invalid = await save(author, bad.id, { ...body, destination: "personal" });
    expect(invalid.status).toBe(400);
    expect(invalid.json.code).toBe("invalid_skill_md");
    for (const wrong of [
      { ...body, destination: "site" },
      { destination: "personal", changelog: "x" },
      { destination: "personal", semver: "1.0", changelog: "x" },
      { destination: "personal", semver: "1.0.0" },
    ])
      expect((await save(author, d.id, wrong)).status, JSON.stringify(wrong)).toBe(400);
  });

  it("saves to personal only for the author; started from a conversation it needs confirming", async () => {
    const d = await draftWith(author, "from-chat");
    await author.request("PATCH", `/v1/skills/drafts/${d.id}`, { shared: true }, ifMatch(d.rev));
    await h.admin.query(`UPDATE skill_drafts SET from_thread_id = $2 WHERE id = $1`, [
      d.id,
      randomUUID(),
    ]);
    const body = { destination: "personal", semver: "0.1.0", changelog: "Mine." };
    expect((await save(builder, d.id, body)).status).toBe(403);
    const unconfirmed = await save(author, d.id, body);
    expect(unconfirmed.status).toBe(409);
    expect(unconfirmed.json).toMatchObject({ code: "confirm_personal_required" });
    expect(unconfirmed.json.message).toContain("Finance");
    const saved = await save(author, d.id, { ...body, confirmPersonal: true });
    expect(saved.status, JSON.stringify(saved.json)).toBe(201);
    expect(saved.json.skill).toMatchObject({ scope: "personal", slug: "from-chat" });
    const audit = await h.admin.query<{ team_id: string; target: Record<string, unknown> }>(
      `SELECT team_id, target FROM audit_log WHERE action = 'skill.draft.personalized'`,
    );
    expect(audit.rows).toEqual([
      {
        team_id: team,
        target: {
          draftId: d.id,
          skillId: saved.json.skill.id,
          slug: "from-chat",
          semver: "0.1.0",
        },
      },
    ]);
  });

  it("saves a draft not started from a conversation to personal without confirming", async () => {
    const d = await draftWith(author, "plain-personal");
    const res = await save(author, d.id, {
      destination: "personal",
      semver: "0.1.0",
      changelog: "Mine.",
    });
    expect(res.status, JSON.stringify(res.json)).toBe(201);
  });
});

describe("retention and offboarding (ac-3)", () => {
  const draftRows = async (teamId: string) =>
    (
      await h.admin.query<{ id: string }>(`SELECT id FROM skill_drafts WHERE team_id = $1`, [
        teamId,
      ])
    ).rows.map((r) => r.id);

  it("purges drafts unchanged for longer than the team's window, unless held", async () => {
    const retTeam = randomUUID();
    await h.admin.query(`INSERT INTO teams (id, slug, name) VALUES ($1, $2, 'Retention')`, [
      retTeam,
      `ret-${retTeam.slice(0, 8)}`,
    ]);
    const heldId = await h.createUser(`held-${retTeam.slice(0, 6)}@drafts.test`);
    const ids: Record<string, string> = {};
    for (const [key, owner] of [
      ["old", authorId],
      ["recent", authorId],
      ["held", heldId],
    ] as const) {
      const { rows } = await h.admin.query<{ id: string }>(
        `INSERT INTO skill_drafts (team_id, owner_user_id, updated_by, name) VALUES ($1, $2, $2, $3)
         RETURNING id`,
        [retTeam, owner, `d-${key}`],
      );
      ids[key] = rows[0]?.id ?? "";
    }
    await h.admin.query(
      `INSERT INTO skill_draft_files (team_id, draft_id, path, text_content, size) VALUES ($1, $2, 'SKILL.md', 'x', 1)`,
      [retTeam, ids.old],
    );
    await h.admin.query(
      `UPDATE skill_drafts SET updated_at = now() - interval '31 days' WHERE team_id = $1 AND id <> $2`,
      [retTeam, ids.recent],
    );
    await h.admin.query(
      `INSERT INTO team_retention (team_id, period, updated_by) VALUES ($1, '30d', $2)`,
      [retTeam, authorId],
    );
    const hold = await placeHold(retTeam, heldId);
    await runRetentionPass({ db: h.deps.database.db, logger: pino({ level: "silent" }) });
    expect((await draftRows(retTeam)).sort()).toEqual([ids.recent, ids.held].sort());
    const audited = await h.admin.query<{ target: unknown }>(
      `SELECT target FROM audit_log WHERE team_id = $1 AND action = 'retention.skill_drafts_purged'`,
      [retTeam],
    );
    expect(audited.rows).toEqual([{ target: { rows: 1 } }]);
    await releaseHold(hold);
    await runRetentionPass({ db: h.deps.database.db, logger: pino({ level: "silent" }) });
    expect(await draftRows(retTeam)).toEqual([ids.recent]);
  });

  it("goes with a departed author's data at offboarding, unless held", async () => {
    const offTeam = randomUUID();
    await h.admin.query(`INSERT INTO teams (id, slug, name) VALUES ($1, $2, 'Off')`, [
      offTeam,
      `off-${offTeam.slice(0, 8)}`,
    ]);
    for (const owner of [authorId, builderId])
      await h.admin.query(
        `INSERT INTO skill_drafts (team_id, owner_user_id, updated_by, name, shared)
         VALUES ($1, $2, $2, 'gone', true)`,
        [offTeam, owner],
      );
    const purge = () =>
      withTeam(h.deps.database.db, offTeam, (tx) => purgeDepartedDraftsInTx(tx, offTeam, authorId));
    const hold = await placeHold(offTeam, authorId);
    expect(await purge()).toBe(0);
    await releaseHold(hold);
    expect(await purge()).toBe(1);
    const left = await h.admin.query<{ owner_user_id: string }>(
      `SELECT owner_user_id FROM skill_drafts WHERE team_id = $1`,
      [offTeam],
    );
    expect(left.rows).toEqual([{ owner_user_id: builderId }]);
  });
});

const holdAdmins = new Map<string, { placer: string; approver: string }>();

async function placeHold(teamId: string, userId: string | null): Promise<string> {
  const placer = await h.createUser(`hp-${randomUUID().slice(0, 8)}@drafts.test`, "admin");
  const approver = await h.createUser(`ha-${randomUUID().slice(0, 8)}@drafts.test`, "admin");
  const { rows } = await h.admin.query<{ id: string }>(
    `INSERT INTO legal_holds (team_id, user_id, reason, placed_by) VALUES ($1, $2, 'matter', $3) RETURNING id`,
    [teamId, userId, placer],
  );
  const id = rows[0]?.id ?? "";
  await h.admin.query(`UPDATE legal_holds SET status = 'active', approved_by = $2 WHERE id = $1`, [
    id,
    approver,
  ]);
  holdAdmins.set(id, { placer, approver });
  return id;
}

async function releaseHold(id: string): Promise<void> {
  const admins = holdAdmins.get(id);
  if (!admins) throw new Error(`no hold ${id}`);
  await h.admin.query(
    `UPDATE legal_holds SET release_requested_by = $2, release_requested_at = now(),
       release_reason = 'closed' WHERE id = $1`,
    [id, admins.placer],
  );
  await h.admin.query(
    `UPDATE legal_holds SET status = 'released', released_by = $2 WHERE id = $1`,
    [id, admins.approver],
  );
}
