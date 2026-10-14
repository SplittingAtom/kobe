import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RunFixture } from "./testing/run-fixture.js";
import type { Person } from "./testing/event-stream-fixture.js";
import { MemoryObjects } from "./testing/memory-objects.js";
import type { BlobStore } from "./retention/index.js";
import { MAX_OUTPUT_BLOB_BYTES, OUTPUT_INLINE_MAX_BYTES } from "./threads/entry-output.js";

/**
 * KOBE-208 (CE12): a tool output over 64 KB is trimmed to a preview in the entry list and read in
 * full only when its card opens (`GET /v1/threads/{id}/entries/{entryId}/output`), stored inline
 * or in the thread's own object tree. Readable by whoever may read the thread.
 */
const f = new RunFixture();
const objects = new MemoryObjects();
const PREFIX = "kobe/";
const blobs: BlobStore = { objects, prefix: PREFIX };

beforeAll(async () => {
  await f.setup({ blobs, streamTimings: { keepaliveMs: 50, revalidateMs: 100 } });
});
afterAll(async () => {
  await f.teardown();
});

const as = (p: Person) => f.on(0, p);

/** A project thread (author, reader in the project, outsider not) with one answered run. */
async function world() {
  const w = await f.world();
  const author = w.owner;
  const reader = await f.member(w.team);
  const outsider = await f.member(w.team);
  const project = await as(author).post("/v1/projects", {
    name: "Shared",
    members_mode: "selected",
    member_user_ids: [reader.id],
  });
  expect(project.status, JSON.stringify(project.json)).toBe(201);
  const made = await as(author).post("/v1/threads", { project_id: project.json.id, title: "t" });
  const threadId = made.json.thread_id as string;
  const ws = await f.connect(w, 0);
  const runId = await f.message(author, threadId, "hello");
  const entries = ws.reply(await ws.started(runId), "world");
  await ws.acked(runId);
  await f.until(w.team, runId, "completed");
  return { w, author, reader, outsider, threadId, entries };
}
type World = Awaited<ReturnType<typeof world>>;

const toolResult = (id: string, text: string, isError = false) => ({
  type: "message",
  id,
  parentId: null,
  timestamp: "2026-10-02T10:00:00.000Z",
  message: {
    role: "toolResult",
    toolCallId: `call-${id}`,
    toolName: "bash",
    content: [{ type: "text", text }],
    isError,
  },
});

/** Adds an entry under the answer: inline, or stored at `key` (offloaded, payload empty). */
async function addEntry(x: World, id: string, payload: object, key?: string) {
  await f.fx.admin.query(
    `INSERT INTO thread_entries (team_id, thread_id, entry_id, parent_id, type, payload, blob_ref)
     VALUES ($1, $2, $3, $4, 'message', $5, $6)`,
    [x.w.team, x.threadId, id, x.entries.assistant, key ? {} : payload, key ?? null],
  );
}
const tree = (x: World) => `${PREFIX}teams/${x.w.team}/threads/${x.threadId}/entries/`;
const output = (x: World, id: string) => `/v1/threads/${x.threadId}/entries/${id}/output`;

describe("large tool outputs (KOBE-208)", () => {
  it("trims a large inline output in the entry list and reads it in full on demand", async () => {
    const x = await world();
    const big = "y".repeat(OUTPUT_INLINE_MAX_BYTES + 10);
    await addEntry(x, "big", toolResult("big", big));
    await addEntry(x, "small", toolResult("small", "ok"));

    const detail = await as(x.author).get(`/v1/threads/${x.threadId}`);
    const listed = (id: string) =>
      (detail.json.entries as Record<string, unknown>[]).find((e) => e.entry_id === id);
    expect(listed("big")).toMatchObject({
      payload_truncated: true,
      payload: { message: { role: "toolResult", toolCallId: "call-big", isError: false } },
    });
    expect(JSON.stringify(listed("big")).length).toBeLessThan(10_000);
    expect(listed("small")).not.toHaveProperty("payload_truncated");

    const res = await as(x.author).get(output(x, "big"));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.json).toEqual({
      entry_id: "big",
      tool_call_id: "call-big",
      tool_name: "bash",
      is_error: false,
      text: big,
      truncated: false,
    });
  });

  it("reads an output stored in the thread's own tree; readers once shared; else 404", async () => {
    const x = await world();
    objects.objects.set(`${tree(x)}out`, Buffer.from(JSON.stringify(toolResult("out", "z", true))));
    await addEntry(x, "out", {}, `${tree(x)}out`);
    const url = output(x, "out");

    const own = await as(x.author).get(url);
    expect(own.json).toMatchObject({ tool_call_id: "call-out", is_error: true, text: "z" });
    expect((await as(x.reader).get(url)).status).toBe(404);
    await as(x.author).post(`/v1/threads/${x.threadId}/share`, { visibility: "project" });
    expect((await as(x.reader).get(url)).json).toMatchObject({ text: "z" });
    const outsider = await as(x.outsider).get(url);
    expect([outsider.status, outsider.json.code]).toEqual([404, "thread_not_found"]);
    const other = await f.world();
    expect((await as(other.owner).get(url)).status).toBe(404);

    // In Trash: the owner still reads it; the reader no longer sees the thread.
    expect((await as(x.author).delete(`/v1/threads/${x.threadId}`)).status).toBe(200);
    expect((await as(x.author).get(url)).status).toBe(200);
    expect((await as(x.reader).get(url)).status).toBe(404);
  });

  it("never reads another thread's or team's entry by its id", async () => {
    const x = await world();
    const sibling = await as(x.author).post("/v1/threads", { title: "B" });
    await f.fx.admin.query(
      `INSERT INTO thread_entries (team_id, thread_id, entry_id, parent_id, type, payload)
       VALUES ($1, $2, 'only-in-b', NULL, 'message', $3)`,
      [x.w.team, sibling.json.thread_id, toolResult("only-in-b", "secret")],
    );
    const other = await world();
    await addEntry(other, "only-other-team", toolResult("only-other-team", "secret"));
    for (const id of ["only-in-b", "only-other-team"]) {
      const res = await as(x.author).get(output(x, id));
      expect([res.status, res.json.code], id).toEqual([404, "entry_not_found"]);
    }
  });

  it("refuses ids, entries and stored bodies it can't or mustn't read", async () => {
    const x = await world();
    expect((await as(x.author).get(output(x, "x".repeat(129)))).status).toBe(400);
    const missing = await as(x.author).get(output(x, "nope"));
    expect([missing.status, missing.json.code]).toEqual([404, "entry_not_found"]);
    const notTool = await as(x.author).get(output(x, x.entries.assistant));
    expect([notTool.status, notTool.json.code]).toEqual([409, "not_a_tool_output"]);

    const unavailable = async (id: string) => {
      const res = await as(x.author).get(output(x, id));
      expect([res.status, res.json.code], id).toEqual([409, "entry_unavailable"]);
    };
    // Outside this thread's tree (another thread's object): never read.
    const foreign = `${PREFIX}teams/${x.w.team}/threads/${randomUUID()}/entries/x`;
    objects.objects.set(foreign, Buffer.from(JSON.stringify(toolResult("f", "secret"))));
    await addEntry(x, "foreign", {}, foreign);
    await unavailable("foreign");
    await addEntry(x, "gone", {}, `${tree(x)}gone`);
    await unavailable("gone");
    objects.objects.set(`${tree(x)}bad`, Buffer.from("not json"));
    await addEntry(x, "bad", {}, `${tree(x)}bad`);
    await unavailable("bad");
    // Over the cap: as declared, and streamed past a size that understated it.
    objects.objects.set(`${tree(x)}huge`, Buffer.alloc(MAX_OUTPUT_BLOB_BYTES + 1, 0x20));
    await addEntry(x, "huge", {}, `${tree(x)}huge`);
    await unavailable("huge");
    const real = objects.get.bind(objects);
    objects.get = async (key) => {
      if (!key.endsWith("/liar")) return real(key);
      const chunk = Buffer.alloc(1024 * 1024, 0x20);
      return { body: Readable.from(Array.from({ length: 9 }, () => chunk)), size: 10 };
    };
    await addEntry(x, "liar", {}, `${tree(x)}liar`);
    try {
      await unavailable("liar");
    } finally {
      objects.get = real;
    }
  });
});
