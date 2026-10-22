import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createDb, type KobeDatabase } from "./client.js";
import { SKILL_DRAFT_MAX_BYTES, skillDraftFiles, skillDrafts } from "./schema/index.js";
import { withTeam } from "./with-team.js";

/**
 * Workbench drafts in the database (KOBE-320, SK11): one content column per file; the draft's
 * size, file count and co-editing kept by the database from its files; author and provenance
 * immutable; files that never move; a draft's files gone with it; and the legal-hold history
 * (D18, the KOBE-275 pattern): held content is copied aside on every overwrite or delete, the
 * copies immutable and kept while the hold lasts. Isolation: probe.db.test; policies: catalog.
 */
let app: KobeDatabase;
const admin = new pg.Client({ connectionString: inject("adminUrl") });
const appClient = new pg.Client({ connectionString: inject("appUrl") });
const owner = new pg.Client({ connectionString: inject("ownerUrl") });
let teamA = "";
let teamB = "";
let alice = "";
let bob = "";
let requester = "";
let approver = "";

async function user(name: string, role?: "admin"): Promise<string> {
  const id = randomUUID();
  await admin.query(`INSERT INTO users (id, name, email) VALUES ($1, $2, $3)`, [
    id,
    name,
    `${id}@dr.test`,
  ]);
  if (role) await admin.query(`INSERT INTO site_roles (user_id, role) VALUES ($1, $2)`, [id, role]);
  return id;
}

async function team(): Promise<string> {
  const id = randomUUID();
  await admin.query(`INSERT INTO teams (id, slug, name) VALUES ($1, $2, 'Drafts')`, [
    id,
    `dr-${id.slice(0, 8)}`,
  ]);
  return id;
}

beforeAll(async () => {
  await Promise.all([admin.connect(), appClient.connect(), owner.connect()]);
  app = createDb(inject("appUrl"));
  [teamA, teamB] = [await team(), await team()];
  alice = await user("Alice");
  bob = await user("Bob");
  requester = await user("Requester", "admin");
  approver = await user("Approver", "admin");
});

afterAll(async () => {
  await app.close();
  await Promise.all([admin.end(), appClient.end(), owner.end()]);
});

async function sqlState(promise: Promise<unknown>): Promise<string | undefined> {
  const err: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (err === undefined) return undefined;
  const e = err as { code?: string; cause?: { code?: string } };
  return e.cause?.code ?? e.code ?? String(err);
}

async function newDraft(teamId = teamA, name = "demo", by = alice): Promise<string> {
  return withTeam(app.db, teamId, async (tx) => {
    const [row] = await tx
      .insert(skillDrafts)
      .values({ teamId, ownerUserId: by, updatedBy: by, name })
      .returning({ id: skillDrafts.id });
    if (!row) throw new Error("no draft");
    return row.id;
  });
}

const file = (draftId: string, path: string, text: string, by = alice, teamId = teamA) => ({
  teamId,
  draftId,
  path,
  textContent: text,
  size: Buffer.byteLength(text),
  updatedBy: by,
});

async function put(values: ReturnType<typeof file>, teamId = teamA) {
  await withTeam(app.db, teamId, (tx) =>
    tx
      .insert(skillDraftFiles)
      .values(values)
      .onConflictDoUpdate({
        target: [skillDraftFiles.teamId, skillDraftFiles.draftId, skillDraftFiles.path],
        set: { textContent: values.textContent, size: values.size, updatedBy: values.updatedBy },
      }),
  );
}

async function draftRow(teamId: string, id: string) {
  return withTeam(app.db, teamId, async (tx) => {
    const [row] = await tx
      .select({
        size: skillDrafts.sizeBytes,
        files: skillDrafts.fileCount,
        coEdited: skillDrafts.coEdited,
      })
      .from(skillDrafts)
      .where(and(eq(skillDrafts.teamId, teamId), eq(skillDrafts.id, id)));
    return row;
  });
}

async function hold(teamId: string, userId: string | null): Promise<string> {
  const { rows } = await appClient.query<{ id: string }>(
    `INSERT INTO legal_holds (team_id, user_id, reason, placed_by) VALUES ($1, $2, 'matter', $3) RETURNING id`,
    [teamId, userId, requester],
  );
  const id = rows[0]?.id ?? "";
  await appClient.query(
    `UPDATE legal_holds SET status = 'active', approved_by = $2 WHERE id = $1`,
    [id, approver],
  );
  return id;
}

async function release(id: string): Promise<void> {
  await admin.query(
    `UPDATE legal_holds SET release_requested_by = $2, release_requested_at = now(), release_reason = 'done' WHERE id = $1`,
    [id, requester],
  );
  await appClient.query(
    `UPDATE legal_holds SET status = 'released', released_by = $2 WHERE id = $1`,
    [id, approver],
  );
}

const fileHistory = async (draftId: string) =>
  (
    await admin.query<{ path: string; text_content: string; change: string; written_by: string }>(
      `SELECT path, text_content, change, written_by FROM skill_draft_file_history
        WHERE draft_id = $1 ORDER BY kept_at, path`,
      [draftId],
    )
  ).rows;
const draftHistory = async (draftId: string) =>
  (
    await admin.query<{ change: string; shared: boolean }>(
      `SELECT change, shared FROM skill_draft_history WHERE draft_id = $1 ORDER BY kept_at`,
      [draftId],
    )
  ).rows;

describe("skill_drafts", () => {
  it("tracks size and file count from the files, on insert, rewrite and delete", async () => {
    const id = await newDraft();
    await withTeam(app.db, teamA, (tx) =>
      tx.insert(skillDraftFiles).values([
        file(id, "SKILL.md", "héllo"),
        {
          teamId: teamA,
          draftId: id,
          path: "a.bin",
          bytes: Buffer.from([0, 1]),
          size: 2,
          updatedBy: alice,
        },
      ]),
    );
    expect(await draftRow(teamA, id)).toEqual({ size: 8, files: 2, coEdited: false });
    await put(file(id, "SKILL.md", "hi"));
    expect(await draftRow(teamA, id)).toMatchObject({ size: 4, files: 2 });
    await withTeam(app.db, teamA, (tx) =>
      tx
        .delete(skillDraftFiles)
        .where(and(eq(skillDraftFiles.draftId, id), eq(skillDraftFiles.path, "a.bin"))),
    );
    expect(await draftRow(teamA, id)).toMatchObject({ size: 2, files: 1 });
  });

  it("caps a whole draft at 5 MiB, whoever writes", async () => {
    const id = await newDraft();
    const half = Buffer.alloc(SKILL_DRAFT_MAX_BYTES / 2 + 1, 1);
    const bin = (path: string) => ({
      teamId: teamA,
      draftId: id,
      path,
      bytes: half,
      size: half.length,
      updatedBy: alice,
    });
    await withTeam(app.db, teamA, (tx) => tx.insert(skillDraftFiles).values(bin("one.bin")));
    const state = await sqlState(
      withTeam(app.db, teamA, (tx) => tx.insert(skillDraftFiles).values(bin("two.bin"))),
    );
    expect(state).toBe("23514");
    expect(await draftRow(teamA, id)).toMatchObject({ size: half.length, files: 1 });
  });

  it("refuses a file with both or neither content, a wrong size, or an empty path", async () => {
    const id = await newDraft();
    const insert = (values: Partial<typeof skillDraftFiles.$inferInsert>) =>
      sqlState(
        withTeam(app.db, teamA, (tx) =>
          tx.insert(skillDraftFiles).values({
            teamId: teamA,
            draftId: id,
            path: "x",
            size: 1,
            updatedBy: alice,
            ...values,
          }),
        ),
      );
    expect(await insert({ textContent: "x", bytes: Buffer.from([1]) })).toBe("23514");
    expect(await insert({})).toBe("23514");
    expect(await insert({ textContent: "xy" })).toBe("23514");
    expect(await insert({ path: "", textContent: "x" })).toBe("23514");
    expect(await insert({ path: "a".repeat(241), textContent: "x" })).toBe("23514");
  });

  it("keeps size and count to the database, author and provenance fixed, files in their draft", async () => {
    const id = await newDraft();
    const other = await newDraft();
    const update = (set: Partial<typeof skillDrafts.$inferInsert>) =>
      sqlState(
        withTeam(app.db, teamA, (tx) =>
          tx.update(skillDrafts).set(set).where(eq(skillDrafts.id, id)),
        ),
      );
    expect(
      await sqlState(
        withTeam(app.db, teamA, (tx) =>
          tx.insert(skillDrafts).values({
            teamId: teamA,
            ownerUserId: alice,
            updatedBy: alice,
            name: "sized",
            sizeBytes: 10,
          }),
        ),
      ),
    ).toBe("55000");
    expect(await update({ sizeBytes: 0, fileCount: 3 })).toBe("55000");
    expect(await update({ ownerUserId: bob })).toBe("55000");
    expect(await update({ startedFrom: "upload" })).toBe("55000");
    await put(file(id, "SKILL.md", "x"));
    expect(
      await sqlState(
        withTeam(app.db, teamA, (tx) =>
          tx.update(skillDraftFiles).set({ draftId: other }).where(eq(skillDraftFiles.draftId, id)),
        ),
      ),
    ).toBe("55000");
    // Other columns change freely.
    expect(await update({ shared: true, rev: 2 })).toBeUndefined();
  });

  it("marks a draft co-edited, for good, once anyone but its author writes", async () => {
    const id = await newDraft();
    await put(file(id, "SKILL.md", "mine"));
    expect((await draftRow(teamA, id))?.coEdited).toBe(false);
    await put(file(id, "notes.md", "theirs", bob));
    expect((await draftRow(teamA, id))?.coEdited).toBe(true);
    const back = sqlState(
      withTeam(app.db, teamA, (tx) =>
        tx.update(skillDrafts).set({ coEdited: false }).where(eq(skillDrafts.id, id)),
      ),
    );
    expect(await back).toBe("55000");
    const other = await newDraft();
    await withTeam(app.db, teamA, (tx) =>
      tx.update(skillDrafts).set({ updatedBy: bob }).where(eq(skillDrafts.id, other)),
    );
    expect((await draftRow(teamA, other))?.coEdited).toBe(true);
  });

  it("deletes a draft with its files", async () => {
    const id = await newDraft();
    await put(file(id, "SKILL.md", "x"));
    await withTeam(app.db, teamA, (tx) => tx.delete(skillDrafts).where(eq(skillDrafts.id, id)));
    const left = await withTeam(app.db, teamA, (tx) =>
      tx.select().from(skillDraftFiles).where(eq(skillDraftFiles.draftId, id)),
    );
    expect(left).toHaveLength(0);
  });

  it("refuses a file under another team's draft", async () => {
    const id = await newDraft(teamB);
    const state = await sqlState(put(file(id, "SKILL.md", "x", alice, teamA)));
    // The composite key: (team A, B's draft id) names no draft.
    expect(state).toBe("23503");
  });

  it("refuses a malformed name or start, and provenance that doesn't fit the start", async () => {
    const bad = (values: Partial<typeof skillDrafts.$inferInsert>) =>
      sqlState(
        withTeam(app.db, teamA, (tx) =>
          tx
            .insert(skillDrafts)
            .values({ teamId: teamA, ownerUserId: alice, updatedBy: alice, name: "ok", ...values }),
        ),
      );
    expect(await bad({ name: "Not-OK" })).toBe("23514");
    expect(await bad({ startedFrom: "nowhere" as never })).toBe("23514");
    expect(await bad({ startedFrom: "fork", parentRef: [] as never })).toBe("23514");
    expect(await bad({ startedFrom: "thread" })).toBe("23514");
    expect(await bad({ fromThreadId: randomUUID() })).toBe("23514");
    expect(await bad({ startedFrom: "fork" })).toBe("23514");
    expect(await bad({ parentRef: { kind: "catalog" } })).toBe("23514");
    expect(await bad({ startedFrom: "thread", fromThreadId: randomUUID() })).toBeUndefined();
    expect(await bad({ startedFrom: "fork", parentRef: { kind: "catalog" } })).toBeUndefined();
    // A governed import (KOBE-344): a git draft always has its origin; only git and upload may.
    const origin = { kind: "git", url: "https://git.example.org/o/r" };
    expect(await bad({ startedFrom: "git" })).toBe("23514");
    expect(await bad({ startedFrom: "template", origin })).toBe("23514");
    expect(await bad({ startedFrom: "git", origin: [] as never })).toBe("23514");
    expect(await bad({ startedFrom: "git", origin })).toBeUndefined();
    expect(
      await bad({ startedFrom: "upload", origin: { ...origin, kind: "zip" } }),
    ).toBeUndefined();
  });

  it("never changes an import's origin (KOBE-344)", async () => {
    const [row] = await withTeam(app.db, teamA, (tx) =>
      tx
        .insert(skillDrafts)
        .values({
          teamId: teamA,
          ownerUserId: alice,
          updatedBy: alice,
          name: "imported",
          startedFrom: "git",
          origin: { kind: "git", url: "https://git.example.org/o/r" },
        })
        .returning({ id: skillDrafts.id }),
    );
    expect(
      await sqlState(
        withTeam(app.db, teamA, (tx) =>
          tx
            .update(skillDrafts)
            .set({ origin: { kind: "git", url: "https://evil.example.org/x" } })
            .where(eq(skillDrafts.id, row?.id as string)),
        ),
      ),
    ).toBe("55000");
  });
});

describe("legal hold (D18): held content is copied aside, never refused", () => {
  it("keeps a held author's overwritten and deleted files, and the draft they delete", async () => {
    const t = await team();
    const held = await user("Held");
    const id = await newDraft(t, "held", held);
    await put(file(id, "SKILL.md", "v1", held, t), t);
    await put(file(id, "notes.md", "n1", held, t), t);
    const h = await hold(t, held);
    await put(file(id, "SKILL.md", "v2", held, t), t);
    // A retry with the same content keeps nothing.
    await put(file(id, "SKILL.md", "v2", held, t), t);
    await withTeam(app.db, t, (tx) =>
      tx
        .delete(skillDraftFiles)
        .where(and(eq(skillDraftFiles.draftId, id), eq(skillDraftFiles.path, "notes.md"))),
    );
    await withTeam(app.db, t, (tx) => tx.delete(skillDrafts).where(eq(skillDrafts.id, id)));
    expect(await fileHistory(id)).toEqual([
      { path: "SKILL.md", text_content: "v1", change: "overwritten", written_by: held },
      { path: "notes.md", text_content: "n1", change: "deleted", written_by: held },
      { path: "SKILL.md", text_content: "v2", change: "deleted", written_by: held },
    ]);
    expect(await draftHistory(id)).toEqual([{ change: "deleted", shared: false }]);
    await release(h);
  });

  it("keeps a held co-editor's content when an unheld author overwrites or deletes it", async () => {
    const t = await team();
    const author = await user("Author");
    const coEditor = await user("CoEditor");
    const id = await newDraft(t, "shared", author);
    await put(file(id, "SKILL.md", "by author", author, t), t);
    await put(file(id, "scripts/x.py", "by co-editor", coEditor, t), t);
    const h = await hold(t, coEditor);
    // The author's own content is not held: rewriting it keeps nothing.
    await put(file(id, "SKILL.md", "author again", author, t), t);
    await put(file(id, "scripts/x.py", "author took over", author, t), t);
    expect(await fileHistory(id)).toEqual([
      {
        path: "scripts/x.py",
        text_content: "by co-editor",
        change: "overwritten",
        written_by: coEditor,
      },
    ]);
    await release(h);
  });

  it("keeps a held co-editor's attribution when someone re-saves the same content (R1)", async () => {
    const t = await team();
    const author = await user("Author");
    const coEditor = await user("CoEditor");
    const id = await newDraft(t, "resave", author);
    await put(file(id, "scripts/x.py", "by co-editor", coEditor, t), t);
    const h = await hold(t, coEditor);
    await put(file(id, "scripts/x.py", "by co-editor", author, t), t);
    const [row] = (
      await admin.query<{ updated_by: string }>(
        `SELECT updated_by FROM skill_draft_files WHERE draft_id = $1`,
        [id],
      )
    ).rows;
    expect(row?.updated_by).toBe(coEditor);
    expect(await fileHistory(id)).toEqual([]);
    await withTeam(app.db, t, (tx) => tx.delete(skillDrafts).where(eq(skillDrafts.id, id)));
    expect(await fileHistory(id)).toEqual([
      {
        path: "scripts/x.py",
        text_content: "by co-editor",
        change: "deleted",
        written_by: coEditor,
      },
    ]);
    await release(h);
  });

  it("keeps a held draft's sharing change and leaves unheld drafts alone", async () => {
    const t = await team();
    const held = await user("Held");
    const free = await user("Free");
    const heldDraft = await newDraft(t, "a", held);
    const freeDraft = await newDraft(t, "b", free);
    const h = await hold(t, held);
    for (const id of [heldDraft, freeDraft])
      await withTeam(app.db, t, (tx) =>
        tx.update(skillDrafts).set({ shared: true }).where(eq(skillDrafts.id, id)),
      );
    expect(await draftHistory(heldDraft)).toEqual([{ change: "changed", shared: false }]);
    expect(await draftHistory(freeDraft)).toEqual([]);
    await release(h);
  });

  it("makes the copies immutable and undeletable while held; TRUNCATE refused under any hold", async () => {
    const t = await team();
    const held = await user("Held");
    const id = await newDraft(t, "copy", held);
    await put(file(id, "SKILL.md", "v1", held, t), t);
    const h = await hold(t, held);
    await put(file(id, "SKILL.md", "v2", held, t), t);
    const asApp = (text: string) =>
      sqlState(withTeam(app.db, t, (tx) => tx.execute(sql.raw(text))));
    expect(await asApp(`UPDATE skill_draft_file_history SET path = 'y'`)).toBe("55000");
    expect(await asApp(`DELETE FROM skill_draft_file_history`)).toBe("KH001");
    for (const table of [
      "skill_drafts",
      "skill_draft_files",
      "skill_draft_history",
      "skill_draft_file_history",
    ])
      expect(await sqlState(owner.query(`TRUNCATE ${table} CASCADE`)), table).toBe("KH001");
    await release(h);
    expect(await asApp(`DELETE FROM skill_draft_file_history`)).toBeUndefined();
    expect(await fileHistory(id)).toEqual([]);
  });
});
