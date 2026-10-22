import { randomUUID } from "node:crypto";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sweepDepartedDraftsInTeam } from "./retention/skill-drafts.js";
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

  it("refuses a created file's traversal, absolute or backslash path itself, not only the browser (KOBE-478)", async () => {
    const draft = await create(author, "created-paths");
    // As the Workbench's Create file sends a path (each segment percent-encoded), with the
    // browser's own checks skipped.
    const encoded = (path: string) => path.split("/").map(encodeURIComponent).join("/");
    for (const path of [
      "/etc/passwd",
      "a//b.md",
      "references\\guide.md",
      "C:\\x.md",
      "a/..%2Fb.md",
    ]) {
      const bad = await write(
        author,
        draft.id,
        encoded(path).replace("..%252F", "..%2F"),
        draft.rev,
        text("x"),
      );
      expect(bad.status, path).toBe(400);
      expect(bad.json.code, path).toBe("invalid_path");
    }
    // A URL's dot segments resolve before the request leaves: `..` can only climb out of
    // `/files/`, where no route writes.
    for (const path of ["../escape.md", "references/../../escape.md"]) {
      const dots = encoded(path).replaceAll("..", "%2E%2E");
      const bad = await write(author, draft.id, dots, draft.rev, text("x"));
      expect(bad.status, path).toBe(404);
    }
    const files = await author.get(`/v1/skills/drafts/${draft.id}`);
    expect((files.json.files as { path: string }[]).map((f) => f.path)).toEqual(["SKILL.md"]);
    const ok = await write(author, draft.id, encoded("templates/forms/a.md"), draft.rev, text("A"));
    expect(ok.status).toBe(200);
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

  it("judges a write before reading its body: an invisible draft or no room is refused first", async () => {
    const draft = await create(author, "body-checks");
    const big = new RawBody(new Uint8Array(6 * 1024 * 1024).fill(2), "application/octet-stream");
    // Over the 5 MiB a draft can hold, at a draft the caller can't see: 404, not 413.
    expect((await write(member, draft.id, "assets/x.bin", 1, big)).status).toBe(404);
    expect((await write(author, draft.id, "assets/x.bin", 1, big)).status).toBe(413);
    expect((await author.get(`/v1/skills/drafts/${draft.id}`)).json.draft.rev).toBe(1);
  });

  it("pages the list, newest change first", async () => {
    const email = `lister-${randomUUID().slice(0, 6)}@drafts.test`;
    const lister = await h.createUser(email);
    await h.admin.query(
      `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'member')`,
      [team, lister],
    );
    await h.admin.query(
      `INSERT INTO skill_drafts (team_id, owner_user_id, updated_by, name, updated_at)
       SELECT $1, $2, $2, 'p-' || n, now() - make_interval(secs => n) FROM generate_series(1, 130) n`,
      [team, lister],
    );
    const who = await h.signIn(email);
    expect((await who.put("/v1/me/teams/active", { teamId: team })).status).toBe(200);
    who.team = team;
    const first = await who.get("/v1/skills/drafts");
    expect(first.json.drafts).toHaveLength(100);
    expect(first.json.drafts[0].name).toBe("p-1");
    const second = await who.get(`/v1/skills/drafts?cursor=${first.json.next as string}`);
    expect(second.json.drafts.map((d: { name: string }) => d.name)).toEqual(
      Array.from({ length: 30 }, (_, i) => `p-${i + 101}`),
    );
    expect(second.json.next).toBeNull();
    expect((await who.get("/v1/skills/drafts?cursor=bogus")).status).toBe(400);
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

  /** A draft of the author's written straight to the database (provenance 322 will set). */
  async function seeded(name: string, start: Record<string, unknown>) {
    const { rows } = await h.admin.query<{ id: string }>(
      `INSERT INTO skill_drafts (team_id, owner_user_id, updated_by, name, started_from, parent_ref, from_thread_id)
       VALUES ($1, $2, $2, $3, $4, $5, $6) RETURNING id`,
      [
        team,
        authorId,
        name,
        start.startedFrom,
        start.parentRef === undefined ? null : JSON.stringify(start.parentRef),
        start.fromThreadId ?? null,
      ],
    );
    const id = rows[0]?.id ?? "";
    await h.admin.query(
      `INSERT INTO skill_draft_files (team_id, draft_id, path, text_content, size, updated_by)
       VALUES ($1, $2, 'SKILL.md', $3, octet_length($3), $4)`,
      [team, id, skillMd(name), authorId],
    );
    const read = await author.get(`/v1/skills/drafts/${id}`);
    return { id, rev: read.json.draft.rev as number };
  }

  const save = (who: TestBrowser, id: string, body: Record<string, unknown>, rev?: number) =>
    who.request(
      "POST",
      `/v1/skills/drafts/${id}/versions`,
      body,
      rev === undefined ? {} : ifMatch(rev),
    );
  const personal = { destination: "personal", semver: "0.1.0", changelog: "Mine." };
  const personalized = async (draftId: string) =>
    (
      await h.admin.query<{ team_id: string; target: Record<string, unknown> }>(
        `SELECT team_id, target FROM audit_log
          WHERE action = 'skill.draft.personalized' AND target ->> 'draftId' = $1`,
        [draftId],
      )
    ).rows;

  it("saves to the team as a pending version (D22 review), audited with the draft", async () => {
    const d = await draftWith(builder, "team-saved");
    const body = { destination: "team", semver: "1.0.0", changelog: "First version." };
    expect((await save(builder, d.id, body)).status).toBe(428);
    const res = await save(builder, d.id, body, d.rev);
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
    const audit = await h.admin.query<{ team_id: string; target: Record<string, unknown> }>(
      `SELECT team_id, target FROM audit_log WHERE action = 'skill.uploaded' AND target ->> 'skillId' = $1`,
      [res.json.skill.id],
    );
    expect(audit.rows[0]).toMatchObject({
      team_id: team,
      target: { draftId: d.id, semver: "1.0.0" },
    });
    expect(await personalized(d.id)).toEqual([]);
    // The draft stays for the next version; an unchanged one is refused.
    const again = await save(builder, d.id, { ...body, semver: "1.0.1" }, d.rev);
    expect(again.status).toBe(409);
    expect(again.json.code).toBe("unchanged");
  });

  it("refuses a team save to a plain member, a stale revision and an invalid package", async () => {
    const d = await draftWith(author, "member-draft");
    const body = { destination: "team", semver: "1.0.0", changelog: "x" };
    expect((await save(author, d.id, body, d.rev)).status).toBe(403);
    const stale = await save(author, d.id, personal, d.rev - 1);
    expect(stale.status).toBe(409);
    expect(stale.json).toMatchObject({ code: "stale_revision", changedBy: { id: authorId } });
    const bad = await create(author, "bad-package");
    const res = await write(author, bad.id, "SKILL.md", 1, text("no frontmatter"));
    const invalid = await save(author, bad.id, personal, res.json.rev);
    expect(invalid.status).toBe(400);
    expect(invalid.json.code).toBe("invalid_skill_md");
    for (const wrong of [
      { ...body, destination: "site" },
      { destination: "personal", changelog: "x" },
      { destination: "personal", semver: "1.0", changelog: "x" },
      { destination: "personal", semver: "1.0.0" },
    ])
      expect((await save(author, d.id, wrong, d.rev)).status, JSON.stringify(wrong)).toBe(400);
  });

  it("saves the author's own draft to personal, recorded in the team's audit log", async () => {
    const d = await draftWith(author, "plain-personal");
    const res = await save(author, d.id, personal, d.rev);
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    expect(await personalized(d.id)).toEqual([
      {
        team_id: team,
        target: {
          draftId: d.id,
          skillId: res.json.skill.id,
          slug: "plain-personal",
          semver: "0.1.0",
          fromConversation: false,
          coEdited: false,
        },
      },
    ]);
  });

  it("asks to confirm a draft started from a conversation; only its author saves it as personal", async () => {
    const d = await seeded("from-chat", { startedFrom: "thread", fromThreadId: randomUUID() });
    await author.request("PATCH", `/v1/skills/drafts/${d.id}`, { shared: true }, ifMatch(d.rev));
    const rev = d.rev + 1;
    expect((await save(builder, d.id, personal, rev)).status).toBe(403);
    const unconfirmed = await save(author, d.id, personal, rev);
    expect(unconfirmed.status).toBe(409);
    expect(unconfirmed.json).toMatchObject({ code: "confirm_personal_required" });
    expect(unconfirmed.json.message).toContain("Finance conversation");
    const saved = await save(author, d.id, { ...personal, confirmPersonal: true }, rev);
    expect(saved.status, JSON.stringify(saved.json)).toBe(201);
    expect(saved.json.skill).toMatchObject({ scope: "personal", slug: "from-chat" });
    expect((await personalized(d.id))[0]?.target).toMatchObject({
      fromConversation: true,
      coEdited: false,
    });
  });

  it("asks to confirm a draft team members changed", async () => {
    const d = await draftWith(author, "co-edited");
    await author.request("PATCH", `/v1/skills/drafts/${d.id}`, { shared: true }, ifMatch(d.rev));
    const edit = await write(builder, d.id, "references/b.md", d.rev + 1, text("by builder"));
    expect(edit.status).toBe(200);
    const rev = edit.json.rev as number;
    const unconfirmed = await save(author, d.id, personal, rev);
    expect(unconfirmed.status).toBe(409);
    expect(unconfirmed.json.message).toContain("changes by other Finance members");
    // Unsharing doesn't make it the author's own again.
    const unshared = await author.request(
      "PATCH",
      `/v1/skills/drafts/${d.id}`,
      { shared: false },
      ifMatch(rev),
    );
    expect((await save(author, d.id, personal, unshared.json.draft.rev)).status).toBe(409);
    const saved = await save(
      author,
      d.id,
      { ...personal, confirmPersonal: true },
      unshared.json.draft.rev,
    );
    expect(saved.status).toBe(201);
    expect((await personalized(d.id))[0]?.target).toMatchObject({ coEdited: true });
  });

  it("refuses a fork of a team version as personal (promote it, or save to the team)", async () => {
    const parents = [
      { kind: "team", skillId: randomUUID(), semver: "1.0.0" },
      { kind: "personal", skillId: randomUUID(), semver: "1.0.0", ownerUserId: builderId },
      { kind: "something-new" },
    ];
    for (const [i, parentRef] of parents.entries()) {
      const d = await seeded(`team-fork-${i}`, { startedFrom: "fork", parentRef });
      const res = await save(author, d.id, { ...personal, confirmPersonal: true }, d.rev);
      expect(res.status, JSON.stringify(parentRef)).toBe(409);
      expect(res.json.code).toBe("team_content");
      expect(res.json.message).toContain("Promote it, or save it as a team skill");
    }
    const team = await seeded("team-fork-ok", {
      startedFrom: "fork",
      parentRef: { kind: "team", skillId: randomUUID(), semver: "1.0.0" },
    });
    await author.request(
      "PATCH",
      `/v1/skills/drafts/${team.id}`,
      { shared: true },
      ifMatch(team.rev),
    );
    const asTeam = await save(
      builder,
      team.id,
      { destination: "team", semver: "1.0.0", changelog: "x" },
      team.rev + 1,
    );
    expect(asTeam.status, JSON.stringify(asTeam.json)).toBe(201);
    for (const parentRef of [
      { kind: "catalog", skillId: randomUUID(), semver: "2.0.0" },
      { kind: "personal", skillId: randomUUID(), semver: "1.0.0", ownerUserId: authorId },
    ]) {
      const d = await seeded(`own-fork-${String(parentRef.kind)}`, {
        startedFrom: "fork",
        parentRef,
      });
      expect((await save(author, d.id, personal, d.rev)).status, parentRef.kind).toBe(201);
    }
  });
});

describe("retention and offboarding (ac-3)", () => {
  const draftRows = async (teamId: string) =>
    (
      await h.admin.query<{ id: string }>(`SELECT id FROM skill_drafts WHERE team_id = $1`, [
        teamId,
      ])
    ).rows.map((r) => r.id);
  const kept = async (teamId: string) =>
    (
      await h.admin.query<{ draft_id: string }>(
        `SELECT draft_id FROM skill_draft_history WHERE team_id = $1`,
        [teamId],
      )
    ).rows.map((r) => r.draft_id);

  async function freshTeam(name: string): Promise<string> {
    const id = randomUUID();
    await h.admin.query(`INSERT INTO teams (id, slug, name) VALUES ($1, $2, $3)`, [
      id,
      `${name.toLowerCase()}-${id.slice(0, 8)}`,
      name,
    ]);
    return id;
  }

  async function insertDraft(teamId: string, owner: string, name: string): Promise<string> {
    const { rows } = await h.admin.query<{ id: string }>(
      `INSERT INTO skill_drafts (team_id, owner_user_id, updated_by, name, shared)
       VALUES ($1, $2, $2, $3, true) RETURNING id`,
      [teamId, owner, name],
    );
    const id = rows[0]?.id ?? "";
    await h.admin.query(
      `INSERT INTO skill_draft_files (team_id, draft_id, path, text_content, size, updated_by)
       VALUES ($1, $2, 'SKILL.md', 'x', 1, $3)`,
      [teamId, id, owner],
    );
    return id;
  }

  const pass = () =>
    runRetentionPass({ db: h.deps.database.db, logger: pino({ level: "silent" }) });
  const purges = async (teamId: string) =>
    (
      await h.admin.query<{ target: unknown }>(
        `SELECT target FROM audit_log WHERE team_id = $1 AND action = 'retention.skill_drafts_purged'
          ORDER BY seq`,
        [teamId],
      )
    ).rows.map((r) => r.target);

  it("purges drafts unchanged past the team's window; a held one goes too, into the hold's copy", async () => {
    const t = await freshTeam("Retention");
    const heldId = await h.createUser(`held-${t.slice(0, 6)}@drafts.test`);
    const old = await insertDraft(t, authorId, "d-old");
    const recent = await insertDraft(t, authorId, "d-recent");
    const held = await insertDraft(t, heldId, "d-held");
    await h.admin.query(
      `UPDATE skill_drafts SET updated_at = now() - interval '31 days' WHERE team_id = $1 AND id <> $2`,
      [t, recent],
    );
    await h.admin.query(
      `INSERT INTO team_retention (team_id, period, updated_by) VALUES ($1, '30d', $2)`,
      [t, authorId],
    );
    const hold = await placeHold(t, heldId);
    await pass();
    // The held draft looks purged like any other; its content is in the hold's copy only.
    expect(await draftRows(t)).toEqual([recent]);
    expect(await kept(t)).toEqual([held]);
    expect(await kept(t)).not.toContain(old);
    expect(await purges(t)).toEqual([{ reason: "retention", rows: 2 }]);
    await pass();
    expect(await kept(t)).toEqual([held]);
    await releaseHold(hold);
    await pass();
    expect(await kept(t)).toEqual([]);
    expect(
      (await h.admin.query(`SELECT 1 FROM skill_draft_file_history WHERE team_id = $1`, [t]))
        .rowCount,
    ).toBe(0);
    expect((await purges(t)).at(-1)).toEqual({ reason: "hold_released", rows: 2 });
  });

  it("purges every departed author's drafts 30 days on, with or without a sandbox", async () => {
    const t = await freshTeam("Leavers");
    const stays = await h.createUser(`stays-${t.slice(0, 6)}@drafts.test`);
    const noSandbox = await h.createUser(`nosb-${t.slice(0, 6)}@drafts.test`);
    const withSandbox = await h.createUser(`sb-${t.slice(0, 6)}@drafts.test`);
    const returns = await h.createUser(`back-${t.slice(0, 6)}@drafts.test`);
    const deactivated = await h.createUser(`deact-${t.slice(0, 6)}@drafts.test`);
    for (const u of [stays, returns, deactivated])
      await h.admin.query(
        `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'member')`,
        [t, u],
      );
    const drafts = {
      stays: await insertDraft(t, stays, "stays"),
      noSandbox: await insertDraft(t, noSandbox, "no-sandbox"),
      withSandbox: await insertDraft(t, withSandbox, "with-sandbox"),
      returns: await insertDraft(t, returns, "returns"),
      deactivated: await insertDraft(t, deactivated, "deactivated"),
    };
    await h.admin.query(
      `INSERT INTO sandboxes (team_id, user_id, state, retain_until, state_changed_at)
       VALUES ($1, $2, 'destroyed', now() + interval '30 days', now())`,
      [t, withSandbox],
    );
    await h.admin.query(`UPDATE users SET deactivated_at = now() WHERE id = $1`, [deactivated]);
    await h.admin.query(`DELETE FROM team_members WHERE team_id = $1 AND user_id = $2`, [
      t,
      returns,
    ]);
    const sweep = () => h.deps.offboarding.sweep();
    expect((await sweep()).drafts).toBe(0);
    const marked = await h.admin.query<{ id: string }>(
      `SELECT id FROM skill_drafts WHERE team_id = $1 AND owner_departed_at IS NOT NULL ORDER BY id`,
      [t],
    );
    expect(marked.rows.map((r) => r.id).sort()).toEqual(
      [drafts.noSandbox, drafts.withSandbox, drafts.returns, drafts.deactivated].sort(),
    );
    // A return within the 30 days keeps the drafts.
    await h.admin.query(
      `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'member')`,
      [t, returns],
    );
    await sweep();
    await h.admin.query(
      `UPDATE skill_drafts SET owner_departed_at = now() - interval '31 days'
        WHERE team_id = $1 AND owner_departed_at IS NOT NULL`,
      [t],
    );
    await sweep();
    expect((await draftRows(t)).sort()).toEqual([drafts.stays, drafts.returns].sort());
    expect(await purges(t)).toEqual([{ reason: "offboarding", rows: 3 }]);
    // Leaving again, after a return, starts a new 30 days.
    await h.admin.query(`DELETE FROM team_members WHERE team_id = $1 AND user_id = $2`, [
      t,
      returns,
    ]);
    await sweep();
    await h.admin.query(
      `UPDATE skill_drafts SET owner_departed_at = now() - interval '31 days'
        WHERE team_id = $1 AND owner_departed_at IS NOT NULL`,
      [t],
    );
    await sweep();
    expect(await draftRows(t)).toEqual([drafts.stays]);
  });

  it("keeps a held departed author's drafts in the hold's copy only", async () => {
    const t = await freshTeam("HeldLeaver");
    const leaver = await h.createUser(`hl-${t.slice(0, 6)}@drafts.test`);
    const id = await insertDraft(t, leaver, "held-leaver");
    const hold = await placeHold(t, leaver);
    await sweepDepartedDraftsInTeam(h.deps.database.db, t, 30);
    await h.admin.query(
      `UPDATE skill_drafts SET owner_departed_at = now() - interval '31 days' WHERE team_id = $1`,
      [t],
    );
    expect(await sweepDepartedDraftsInTeam(h.deps.database.db, t, 30)).toBe(1);
    expect(await draftRows(t)).toEqual([]);
    expect(await kept(t)).toEqual([id]);
    await releaseHold(hold);
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
