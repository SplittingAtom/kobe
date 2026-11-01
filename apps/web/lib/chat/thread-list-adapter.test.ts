import { describe, expect, it } from "vitest";
import type { ApiError } from "../api/client";
import { createChatApi } from "./api";
import { ChatSession, titleFrom } from "./session";
import { FakeKobe } from "./testing/fake-kobe";
import { ChatApiError, createThreadListAdapter } from "./thread-list-adapter";

function setup() {
  const fake = new FakeKobe();
  const session = new ChatSession({
    teamId: fake.teamId,
    api: createChatApi(fake.teamId, fake.fetch),
  });
  const errors: ApiError[] = [];
  const adapter = createThreadListAdapter(session, { onError: (e) => errors.push(e) });
  return { fake, session, adapter, errors };
}

describe("thread list adapter", () => {
  it("lists threads and Trash (as archived) on the first page", async () => {
    const { fake, adapter } = setup();
    const a = fake.addThread("A");
    const b = fake.addThread("B");
    const thread = fake.threads.get(a);
    if (thread) thread.deleted_at = "2026-10-01T10:00:00.000Z";
    const page = await adapter.list();
    expect(page.threads.map((t) => [t.remoteId, t.status, t.title])).toEqual([
      [b, "regular", "B"],
      [a, "archived", "A"],
    ]);
    expect(page.nextCursor).toBeUndefined();
    // The rail groups by this (CE5).
    expect(page.threads[0]?.custom).toEqual({
      projectId: null,
      scheduled: false,
      workbench: false,
      shared: false,
      visibility: "private",
      pinned: false,
      archived: false,
      folderId: null,
      forkHint: null,
      // The rail's dot (KOBE-301).
      activity: "idle",
    });
  });

  it("lists pinned threads first (by pin time) and archived ones after the page (CE19)", async () => {
    const { fake, adapter } = setup();
    const a = fake.addThread("A");
    const b = fake.addThread("B");
    const c = fake.addThread("C");
    const d = fake.addThread("D");
    Object.assign(fake.threads.get(a) ?? {}, { pinned_at: "2026-10-01T10:00:00.000Z" });
    Object.assign(fake.threads.get(c) ?? {}, { pinned_at: "2026-10-02T10:00:00.000Z" });
    Object.assign(fake.threads.get(d) ?? {}, { archived_at: "2026-10-03T10:00:00.000Z" });
    const page = await adapter.list();
    expect(
      page.threads.map((t) => [t.title, t.custom?.["pinned"], t.custom?.["archived"]]),
    ).toEqual([
      ["C", true, false],
      ["A", true, false],
      ["B", false, false],
      ["D", false, true],
    ]);
    // Later pages are the activity list only: pinned and archived threads never repeat.
    const pinnedReads = fake.requests.filter((r) => r.path.startsWith("/v1/threads/pinned"));
    expect(pinnedReads).toHaveLength(1);
    expect(b).toBeDefined();
  });

  it("reads Current's unfiled lists, and the chosen folder's besides (KOBE-536, TF5)", async () => {
    const { fake, session, adapter } = setup();
    const folder = fake.folders.add("Budgets");
    const loose = fake.addThread("Loose");
    const filed = fake.addThread("Filed");
    const pinned = fake.addThread("Pinned filed");
    const shared = fake.addThread("Shared filed");
    Object.assign(fake.threads.get(filed) ?? {}, { folder_id: folder });
    Object.assign(fake.threads.get(pinned) ?? {}, {
      folder_id: folder,
      pinned_at: "2026-10-01T10:00:00.000Z",
    });
    Object.assign(fake.threads.get(shared) ?? {}, { folder_id: folder, read_only: true });
    const current = await adapter.list();
    expect(current.threads.map((t) => t.title)).toEqual(["Loose", "Shared filed"]);
    expect(fake.requests.map((r) => r.path)).toEqual(
      expect.arrayContaining([
        "/v1/threads/pinned?folder=none&limit=100",
        "/v1/threads?folder=none",
      ]),
    );
    session.panelMemory.choose({ kind: "folder", id: folder });
    const inFolder = await adapter.list();
    // The shared one is listed once although both /shared and the folder's list hold it.
    expect(inFolder.threads.map((t) => [t.title, t.custom?.["folderId"] ?? null])).toEqual([
      ["Loose", null],
      ["Shared filed", folder],
      ["Pinned filed", folder],
      ["Filed", folder],
    ]);
    expect(fake.requests.map((r) => r.path)).toEqual(
      expect.arrayContaining([
        `/v1/threads/pinned?folder=${folder}&limit=100`,
        `/v1/threads?folder=${folder}`,
      ]),
    );
    expect(loose).toBeTruthy();
  });

  it("creates a thread untitled, shows its first line until the server titles it, and seeds its controller", async () => {
    const { fake, session, adapter } = setup();
    session.setNextTitle("  Plot revenue\nby month  ");
    const { remoteId } = await adapter.initialize("local-1");
    // KOBE-219: never sent, or the server would not title it.
    expect(fake.threads.get(remoteId)?.title).toBeNull();
    expect(session.peek(remoteId)?.getState().phase).toBe("ready");
    expect((await adapter.fetch(remoteId)).title).toBe("Plot revenue");
    // The server's title wins once it is there.
    const thread = fake.threads.get(remoteId);
    if (thread) thread.title = "Monthly revenue plot";
    expect((await adapter.list()).threads.find((t) => t.remoteId === remoteId)?.title).toBe(
      "Monthly revenue plot",
    );
    const second = await adapter.initialize("local-2");
    expect((await adapter.fetch(second.remoteId)).title).toBeUndefined(); // used once
  });

  it("maps rename, Trash, restore and Delete forever; reports failures", async () => {
    const { fake, adapter, errors } = setup();
    const t = fake.addThread("X");
    await adapter.rename(t, "  Y  ");
    expect(fake.threads.get(t)?.title).toBe("Y");
    await adapter.archive(t);
    expect(fake.threads.get(t)?.deleted_at).not.toBeNull();
    await adapter.unarchive(t);
    expect(fake.threads.get(t)?.deleted_at).toBeNull();
    // Only from Trash (the server refuses a live thread).
    await expect(adapter.delete(t)).rejects.toBeInstanceOf(ChatApiError);
    await adapter.archive(t);
    await adapter.delete(t);
    expect(fake.threads.has(t)).toBe(false);
    await expect(adapter.fetch("00000000-0000-4000-8000-00000000ffff")).rejects.toThrow(
      "No thread with that id.",
    );
    expect(errors.map((e) => e.code)).toEqual(["not_in_trash", "thread_not_found"]);
  });
});

describe("titleFrom", () => {
  it.each([
    ["hello", "hello"],
    ["  \n  ", undefined],
    ["first line\nsecond", "first line"],
    ["a\u0007b", "ab"],
    ["x".repeat(100), `${"x".repeat(79)}…`],
  ])("%j → %j", (input, expected) => {
    expect(titleFrom(input)).toBe(expected);
  });
});
