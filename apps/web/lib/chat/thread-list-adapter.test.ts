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
  });

  it("creates a thread with the pending title and seeds its controller", async () => {
    const { fake, session, adapter } = setup();
    session.setNextTitle("  Plot revenue\nby month  ");
    const { remoteId } = await adapter.initialize("local-1");
    expect(fake.threads.get(remoteId)?.title).toBe("Plot revenue");
    expect(session.peek(remoteId)?.getState().phase).toBe("ready");
    const second = await adapter.initialize("local-2");
    expect(fake.threads.get(second.remoteId)?.title).toBeNull(); // the title is used once
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
