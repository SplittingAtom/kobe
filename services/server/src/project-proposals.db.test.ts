import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PROJECT_FILES_MAX, type FileEditProposeFrame } from "@kobe/protocol";
import { proposeFileEdit, type ProposeOutcome } from "./sandbox-wire/file-edit-propose.js";
import { RawBody, type TestBrowser } from "./testing/browser.js";
import { must } from "./testing/event-stream-fixture.js";
import {
  PREFIX,
  audits,
  detail,
  fx,
  objects,
  projectUpload,
  rows,
  save,
  seqs,
  setHold,
  settle,
  sha,
  treeOf,
  world,
  type World,
} from "./testing/project-commits-fixture.js";

/**
 * KOBE-591 (projects-in-conversations PE1-PE7) against a real Postgres: `propose_file_edit` for a
 * file of the conversation's own project (existing and new files; readers, other projects and
 * uploads refused), new files in My files, and Accept: `POST /v1/projects/{id}/commits/from-proposal`
 * commits exactly the recorded content as the head tree with that one file replaced or added.
 * The wire gate of the frame (capability, allowance) is covered by file-edit-propose.db.test.ts.
 */

type Who = "admin" | "alice" | "bob" | "carol";

const person = (w: World, who: Who) => (who === "admin" ? w.admin : w.people[who]);

interface Conversation {
  readonly who: Who;
  readonly threadId: string;
  readonly runId: string;
}

/** A conversation of `who` in the project (mounted, as the web creates it) with one run. */
async function conversation(w: World, who: Who, projectId = w.project.id): Promise<Conversation> {
  const made = await w.as[who].post("/v1/threads", { project_id: projectId });
  expect(made.status, JSON.stringify(made.json)).toBe(201);
  const threadId = made.json.thread_id as string;
  const { rows: run } = await fx.admin.query<{ id: string }>(
    `INSERT INTO runs (team_id, thread_id, trigger, status, started_at)
     VALUES ($1, $2, 'user', 'running', now()) RETURNING id`,
    [w.team, threadId],
  );
  return { who, threadId, runId: must(run[0], "run").id };
}

let calls = 0;

async function propose(
  w: World,
  c: Conversation,
  path: string,
  content: string,
  summary = "Edit",
): Promise<ProposeOutcome> {
  const frame: FileEditProposeFrame = {
    v: 1,
    type: "file.edit_propose",
    request_id: `r${calls}`,
    run_id: c.runId,
    thread_id: c.threadId,
    tool_call_id: `call_${calls++}`,
    tool: "propose_file_edit",
    input: { path, content, summary },
  };
  return proposeFileEdit(fx.db, { teamId: w.team, userId: person(w, c.who).id }, frame, 10_000);
}

async function proposals(w: World, runId: string) {
  const { rows: found } = await fx.admin.query<{ payload: Record<string, unknown> }>(
    `SELECT payload FROM run_events WHERE team_id = $1 AND run_id = $2
        AND type = 'file.edit_proposed' ORDER BY seq`,
    [w.team, runId],
  );
  return found.map((r) => r.payload);
}

/** Proposes and returns the recorded proposal's id. */
async function proposed(
  w: World,
  c: Conversation,
  path: string,
  content: string,
  summary?: string,
) {
  const outcome = await propose(w, c, path, content, summary);
  expect(outcome, JSON.stringify(outcome)).toMatchObject({ ok: true });
  const last = (await proposals(w, c.runId)).at(-1);
  return must(last, "proposal").proposal_id as string;
}

function accept(
  b: TestBrowser,
  projectId: string,
  c: Conversation,
  proposalId: string,
  extra: Record<string, unknown> = {},
) {
  return b.post(`/v1/projects/${projectId}/commits/from-proposal`, {
    thread_id: c.threadId,
    proposal_id: proposalId,
    ...extra,
  });
}

const projectPath = (w: World, rel: string) => `/workspace/projects/${w.project.slug}/${rel}`;

async function headSeq(projectId: string): Promise<number> {
  return Math.max(0, ...(await seqs(projectId)));
}

/** Fills the project's head to `n` files with one SQL commit (no objects: tree rows only). */
async function fillHead(w: World, n: number): Promise<void> {
  const projectId = w.project.id;
  const seq = (await headSeq(projectId)) + 1;
  const author = w.people.alice.id;
  await fx.admin.query(
    `WITH c AS (
       INSERT INTO project_commits (team_id, project_id, seq, parent_id, author_user_id, author_kind,
                                    message, file_count, bytes)
       SELECT $1, $2, $3, head_commit_id, $4, 'user', 'fill', $5::int, $5::bigint FROM projects
        WHERE team_id = $1 AND id = $2
       RETURNING id),
     e AS (
       INSERT INTO project_tree_entries (team_id, commit_id, path, sha256, blob_ref, size_bytes,
                                         mime_type, executable)
       SELECT $1, c.id, 'fill/' || g || '.txt', repeat('0', 64), 'kobe/fill', 1, 'text/plain', false
         FROM c, generate_series(1, $5::int) g)
     UPDATE projects SET head_commit_id = (SELECT id FROM c) WHERE team_id = $1 AND id = $2`,
    [w.team, projectId, seq, author, n],
  );
}

describe("propose_file_edit for the conversation's project (KOBE-591, ac-1, ac-2)", () => {
  it("records project_id, base_commit_seq and base_sha256 for an editor; nothing is written", async () => {
    const w = await world();
    await projectUpload(w.as.alice, w.project.id, "plan.md", "v1\n");
    const head = await headSeq(w.project.id);
    const c = await conversation(w, "bob");
    const outcome = await propose(w, c, projectPath(w, "plan.md"), "v2\n", "Second version");
    expect(outcome).toEqual({
      ok: true,
      path: `projects/${w.project.slug}/plan.md`,
      baseSha256: sha("v1\n"),
    });
    expect(await proposals(w, c.runId)).toEqual([
      {
        tool_call_id: expect.any(String),
        proposal_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        path: `projects/${w.project.slug}/plan.md`,
        base_sha256: sha("v1\n"),
        project_id: w.project.id,
        base_commit_seq: head,
        content: "v2\n",
        summary: "Second version",
      },
    ]);
    expect(await headSeq(w.project.id)).toBe(head);
  });

  it("allows new files (no base_sha256) for owners, editors and unlisted team admins", async () => {
    const w = await world();
    for (const who of ["alice", "bob", "admin"] as const) {
      const c = await conversation(w, who);
      const outcome = await propose(w, c, projectPath(w, `docs/${who}.md`), "new\n");
      expect(outcome, who).toEqual({ ok: true, path: `projects/${w.project.slug}/docs/${who}.md` });
      const [payload] = await proposals(w, c.runId);
      expect(payload).toMatchObject({ project_id: w.project.id, base_commit_seq: 0 });
      expect(payload).not.toHaveProperty("base_sha256");
    }
  });

  it("refuses a reader's run with the project's name", async () => {
    const w = await world();
    await projectUpload(w.as.alice, w.project.id, "plan.md", "v1\n");
    const name = must(
      (
        await fx.admin.query<{ name: string }>(`SELECT name FROM projects WHERE id = $1`, [
          w.project.id,
        ])
      ).rows[0],
      "project",
    ).name;
    const c = await conversation(w, "carol");
    for (const rel of ["plan.md", "new.md"]) {
      expect(await propose(w, c, projectPath(w, rel), "x")).toEqual({
        ok: false,
        code: "read_only",
        message: `You can read ${name} but not change it.`,
      });
    }
    expect(await proposals(w, c.runId)).toEqual([]);
  });

  it("refuses other projects, thread uploads, a conversation outside any project, and bad names", async () => {
    const w = await world();
    const other = await w.as.alice.post("/v1/projects", {
      name: `Other ${randomUUID().slice(0, 4)}`,
    });
    expect(other.status).toBe(201);
    const otherSlug = (other.json as { slug: string }).slug;
    const c = await conversation(w, "bob");
    await projectUpload(w.as.alice, w.project.id, "a.md", "A\n");
    const readOnly = [
      `/workspace/projects/${otherSlug}/x.md`,
      "uploads/thread/file.txt",
      `/workspace/projects/${w.project.slug}`,
    ];
    for (const path of readOnly) {
      const r = await propose(w, c, path, "x");
      expect(r.ok, path).toBe(false);
    }
    expect(await propose(w, c, `/workspace/projects/${otherSlug}/x.md`, "x")).toMatchObject({
      code: "read_only",
    });
    expect(await propose(w, c, "uploads/thread/file.txt", "x")).toMatchObject({
      code: "read_only",
    });
    // A file path inside a file, and a conflict copy, are not names a project takes.
    expect(await propose(w, c, projectPath(w, "a.md/b.md"), "x")).toMatchObject({
      code: "invalid_path",
    });
    expect(await propose(w, c, projectPath(w, "a.conflict-20261109.md"), "x")).toMatchObject({
      code: "invalid_path",
    });
    // A conversation outside any project: its project paths are read-only.
    const made = await w.as.bob.post("/v1/threads", {});
    const plain = made.json.thread_id as string;
    const { rows: run } = await fx.admin.query<{ id: string }>(
      `INSERT INTO runs (team_id, thread_id, trigger, status, started_at)
       VALUES ($1, $2, 'user', 'running', now()) RETURNING id`,
      [w.team, plain],
    );
    const outside = { who: "bob" as const, threadId: plain, runId: must(run[0], "run").id };
    expect(await propose(w, outside, projectPath(w, "a.md"), "x")).toMatchObject({
      code: "read_only",
    });
    expect(await proposals(w, c.runId)).toEqual([]);
  });

  it("refuses a new file in a full project, not an edit of an existing one", async () => {
    const w = await world();
    await fillHead(w, PROJECT_FILES_MAX);
    const c = await conversation(w, "bob");
    expect(await propose(w, c, projectPath(w, "one-more.md"), "x")).toMatchObject({
      ok: false,
      code: "project_full",
    });
    expect(await propose(w, c, projectPath(w, "fill/1.txt"), "x")).toMatchObject({ ok: true });
  });

  it("proposes new files in My files too (no base), and refuses a path taken by a folder", async () => {
    const w = await world();
    const c = await conversation(w, "bob");
    expect(await propose(w, c, "/workspace/notes/new.md", "hello\n")).toEqual({
      ok: true,
      path: "notes/new.md",
    });
    const [payload] = await proposals(w, c.runId);
    expect(payload).not.toHaveProperty("base_sha256");
    expect(payload).not.toHaveProperty("project_id");
    // Accepting writes it with the save route, base absent = create only.
    expect((await save(w.as.bob, "notes/new.md", "", "hello\n")).status).toBe(400);
    const created = await saveNew(w.as.bob, "notes/new.md", "hello\n");
    expect(created.status, JSON.stringify(created.json)).toBe(200);
    expect(created.json).toMatchObject({ path: "notes/new.md", sha256: sha("hello\n") });
    const again = await saveNew(w.as.bob, "notes/new.md", "other\n");
    expect(again.status).toBe(409);
    expect(again.json).toMatchObject({
      code: "version_conflict",
      current: { sha256: sha("hello\n") },
    });
    expect((await saveNew(w.as.bob, "notes", "x")).status).toBe(409);
    expect((await saveNew(w.as.bob, "notes/new.md/inner.md", "x")).status).toBe(409);
    expect(await propose(w, c, "/workspace/notes", "x")).toMatchObject({ code: "invalid_path" });
  });
});

function saveNew(b: TestBrowser, path: string, content: string) {
  return b.request(
    "PUT",
    `/v1/workspace/file?${new URLSearchParams({ path }).toString()}`,
    new RawBody(Buffer.from(content), "text/plain"),
    { "content-length": String(Buffer.byteLength(content)) },
  );
}

describe("Accept commits the proposal (KOBE-591, ac-3)", () => {
  it("commits exactly the recorded bytes as the head with one file replaced; audited; idempotent", async () => {
    const w = await world();
    const { id } = w.project;
    await projectUpload(w.as.alice, id, "plan.md", "v1\n");
    await projectUpload(w.as.alice, id, "keep.md", "K\n");
    const before = await headSeq(id);
    // alice keeps the project mounted with a conversation of her own.
    await conversation(w, "alice");
    const c = await conversation(w, "bob");
    const proposalId = await proposed(w, c, projectPath(w, "plan.md"), "v2\n", "Second version");

    const res = await accept(w.as.bob, id, c, proposalId);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json).toEqual({
      status: "committed",
      seq: before + 1,
      commit_id: expect.any(String),
    });
    const d = await detail(w.as.carol, id, before + 1);
    expect(treeOf(d)).toEqual({ "plan.md": sha("v2\n"), "keep.md": sha("K\n") });
    expect(d.diff).toEqual([expect.objectContaining({ change: "modified", path: "plan.md" })]);
    const { rows: commit } = await fx.admin.query(
      `SELECT author_user_id, author_kind, thread_id, run_id, message FROM project_commits
        WHERE project_id = $1 AND seq = $2`,
      [id, before + 1],
    );
    expect(commit[0]).toEqual({
      author_user_id: w.people.bob.id,
      author_kind: "user",
      thread_id: c.threadId,
      run_id: c.runId,
      message: "Second version",
    });
    // The blob lives in the project's prefix, content-addressed, with the recorded bytes.
    const key = `${PREFIX}teams/${w.team}/projects/${id}/blobs/${sha("v2\n")}`;
    expect(d.tree.find((e) => e.path === "plan.md")?.blob_ref).toBe(key);
    expect(objects.objects.get(key)?.toString()).toBe("v2\n");
    const audit = (await audits(w.team, "project.committed")).at(-1);
    expect(audit).toEqual({
      projectId: id,
      commitId: res.json.commit_id,
      seq: before + 1,
      authorKind: "user",
      threadId: c.threadId,
      runId: c.runId,
      source: "proposal",
      proposalId,
      added: 0,
      modified: 1,
      deleted: 0,
      fileCount: 2,
      bytes: 5,
    });

    // A second accept answers the same commit and writes nothing.
    const again = await accept(w.as.bob, id, c, proposalId, { message: "Other" });
    expect(again.status).toBe(200);
    expect(again.json).toEqual(res.json);
    expect(await headSeq(id)).toBe(before + 1);
    expect((await audits(w.team, "project.committed")).length).toBe(before + 1);

    // Mounted members follow the head (reconciled after the transaction).
    await settle();
    expect((await rows(w.team, w.people.alice.id, w.project.slug)).get("plan.md")?.sha256).toBe(
      sha("v2\n"),
    );
  });

  it("adds a new file, with the edited message", async () => {
    const w = await world();
    const { id } = w.project;
    const c = await conversation(w, "alice");
    const proposalId = await proposed(w, c, projectPath(w, "docs/new.md"), "N\n", "Adds docs");
    const res = await accept(w.as.alice, id, c, proposalId, { message: "  Docs, reviewed  " });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json).toMatchObject({ status: "committed", seq: 1 });
    const d = await detail(w.as.alice, id, 1);
    expect(treeOf(d)).toEqual({ "docs/new.md": sha("N\n") });
    const { rows: commit } = await fx.admin.query(
      `SELECT message FROM project_commits WHERE project_id = $1 AND seq = 1`,
      [id],
    );
    expect(commit[0]).toEqual({ message: "Docs, reviewed" });
    const files = await w.as.carol.get(`/v1/projects/${id}/files`);
    expect(JSON.stringify(files.json)).toContain("docs/new.md");
  });

  it("answers 409 proposal_stale when the file changed (or a new file appeared) since", async () => {
    const w = await world();
    const { id } = w.project;
    await projectUpload(w.as.alice, id, "plan.md", "v1\n");
    const c = await conversation(w, "bob");
    const edit = await proposed(w, c, projectPath(w, "plan.md"), "v2\n");
    const added = await proposed(w, c, projectPath(w, "late.md"), "mine\n");
    // Someone else changes plan.md and adds late.md first.
    expect(
      (
        await w.as.alice.request(
          "DELETE",
          `/v1/projects/${id}/files/${await fileId(id, "plan.md")}`,
        )
      ).status,
    ).toBe(204);
    await projectUpload(w.as.alice, id, "plan.md", "v1b\n");
    await projectUpload(w.as.alice, id, "late.md", "theirs\n");
    const head = await headSeq(id);
    for (const proposalId of [edit, added]) {
      const res = await accept(w.as.bob, id, c, proposalId);
      expect(res.status).toBe(409);
      expect(res.json).toEqual({
        code: "proposal_stale",
        message: expect.stringContaining("changed after the agent proposed"),
        head_seq: head,
      });
    }
    expect(await headSeq(id)).toBe(head);
  });

  it("checks the role at accept time: a demoted editor, another member, a moved conversation", async () => {
    const w = await world();
    const { id } = w.project;
    await projectUpload(w.as.alice, id, "plan.md", "v1\n");
    const c = await conversation(w, "bob");
    const proposalId = await proposed(w, c, projectPath(w, "plan.md"), "v2\n");

    // Only the thread's owner: anyone else gets 404, whatever their role.
    for (const who of ["alice", "admin", "carol"] as const) {
      const res = await accept(w.as[who], id, c, proposalId);
      expect(res.status, who).toBe(404);
    }
    // Not this project's proposal / unknown proposal.
    expect((await accept(w.as.bob, id, c, randomUUID())).status).toBe(404);

    // bob loses edit (back to an implicit reader).
    await fx.admin.query(`DELETE FROM project_members WHERE project_id = $1 AND user_id = $2`, [
      id,
      w.people.bob.id,
    ]);
    const lost = await accept(w.as.bob, id, c, proposalId);
    expect(lost.status).toBe(409);
    expect(lost.json).toMatchObject({ code: "proposal_not_allowed", reason: "no_edit_access" });
    await w.as.alice.post(`/v1/projects/${id}/members`, {
      user_id: w.people.bob.id,
      role: "editor",
    });

    // The conversation moved to another project.
    const other = await w.as.alice.post("/v1/projects", {
      name: `Moved ${randomUUID().slice(0, 4)}`,
    });
    const otherId = (other.json as { id: string }).id;
    await fx.admin.query(`UPDATE threads SET project_id = $2 WHERE id = $1`, [c.threadId, otherId]);
    const moved = await accept(w.as.bob, id, c, proposalId);
    expect(moved.status).toBe(409);
    expect(moved.json).toMatchObject({ code: "proposal_not_allowed", reason: "moved" });
    // ...and accepting it against the other project is no better.
    expect((await accept(w.as.bob, otherId, c, proposalId)).json).toMatchObject({
      code: "proposal_not_allowed",
    });
    await fx.admin.query(`UPDATE threads SET project_id = $2 WHERE id = $1`, [c.threadId, id]);

    // Archived.
    await fx.admin.query(`UPDATE projects SET archived_at = now() WHERE id = $1`, [id]);
    expect((await accept(w.as.bob, id, c, proposalId)).json).toMatchObject({
      code: "proposal_not_allowed",
      reason: "archived",
    });
    await fx.admin.query(`UPDATE projects SET archived_at = NULL WHERE id = $1`, [id]);

    // Back to editor: it commits.
    const ok = await accept(w.as.bob, id, c, proposalId);
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
  });

  it("lets owners and unlisted team admins accept their own proposals; never a reader's run", async () => {
    const w = await world();
    const { id } = w.project;
    for (const who of ["alice", "admin"] as const) {
      const c = await conversation(w, who);
      const proposalId = await proposed(w, c, projectPath(w, `${who}.md`), `${who}\n`);
      const res = await accept(w.as[who], id, c, proposalId);
      expect(res.status, `${who} ${JSON.stringify(res.json)}`).toBe(200);
    }
    expect(treeOf(await detail(w.as.carol, id, 2))).toEqual({
      "alice.md": sha("alice\n"),
      "admin.md": sha("admin\n"),
    });
  });

  it("takes no client content, refuses My files proposals, and is not blocked by a legal hold", async () => {
    const w = await world();
    const { id } = w.project;
    const c = await conversation(w, "bob");
    const proposalId = await proposed(w, c, projectPath(w, "a.md"), "recorded\n");
    const evil = await accept(w.as.bob, id, c, proposalId, { content: "evil" });
    expect(evil.status).toBe(400);
    const mine = await proposed(w, c, "/workspace/notes/mine.md", "x\n");
    expect((await accept(w.as.bob, id, c, mine)).json).toMatchObject({
      code: "proposal_not_allowed",
      reason: "not_a_project_proposal",
    });
    await setHold(w.team, w.admin.id, true);
    try {
      const res = await accept(w.as.bob, id, c, proposalId);
      expect(res.status, JSON.stringify(res.json)).toBe(200);
    } finally {
      await setHold(w.team, w.admin.id, false);
    }
    expect(
      objects.objects
        .get(`${PREFIX}teams/${w.team}/projects/${id}/blobs/${sha("recorded\n")}`)
        ?.toString(),
    ).toBe("recorded\n");
  });

  it("refuses a new file when the project filled up after the proposal", async () => {
    const w = await world();
    const c = await conversation(w, "bob");
    const proposalId = await proposed(w, c, projectPath(w, "last.md"), "x\n");
    await fillHead(w, PROJECT_FILES_MAX);
    const res = await accept(w.as.bob, w.project.id, c, proposalId);
    expect(res.status).toBe(422);
    expect(await headSeq(w.project.id)).toBe(1);
  });

  it("answers 404 to another workspace", async () => {
    const w = await world();
    const c = await conversation(w, "bob");
    const proposalId = await proposed(w, c, projectPath(w, "a.md"), "x\n");
    const other = await world();
    expect((await accept(other.as.bob, w.project.id, c, proposalId)).status).toBe(404);
    expect((await accept(other.as.bob, other.project.id, c, proposalId)).status).toBe(404);
  });
});

async function fileId(projectId: string, path: string): Promise<string> {
  const { rows: found } = await fx.admin.query<{ id: string }>(
    `SELECT id FROM project_files WHERE project_id = $1 AND path = $2`,
    [projectId, path],
  );
  return must(found[0], "file").id;
}
