import { describe, expect, it } from "vitest";
import { forkEntryOf, forkHint, forkOrigin } from "./fork";
import type { ThreadSummary } from "./types";

const summary = (over: Partial<ThreadSummary>): ThreadSummary => ({
  threadId: "t",
  title: "Fork",
  status: "idle",
  ownerUserId: "u",
  projectId: null,
  agentId: null,
  agentVersion: null,
  sharedToProject: false,
  leafEntryId: null,
  lastActivityAt: "2026-10-14T10:00:00.000Z",
  createdAt: "2026-10-14T10:00:00.000Z",
  deletedAt: null,
  purgeAfter: null,
  ...over,
});

describe("forkEntryOf (KOBE-216)", () => {
  it("forks at a committed prompt or an answer's last entry", () => {
    expect(
      forkEntryOf({ kind: "user", entryId: "u1", parentEntryId: null, text: "q", pending: false }),
    ).toBe("u1");
    expect(forkEntryOf({ kind: "assistant", entryIds: ["a1", "t1", "a2"], live: false })).toBe(
      "a2",
    );
  });

  it("offers nothing while the prompt is pending or the answer is live", () => {
    expect(
      forkEntryOf({
        kind: "user",
        entryId: undefined,
        parentEntryId: null,
        text: "",
        pending: true,
      }),
    ).toBeUndefined();
    expect(forkEntryOf({ kind: "assistant", entryIds: ["a1"], live: true })).toBeUndefined();
    expect(forkEntryOf(undefined)).toBeUndefined();
  });
});

describe("forkOrigin and forkHint (KOBE-216 ac-3, ac-6)", () => {
  it("names a source the viewer may open", () => {
    const origin = forkOrigin(
      summary({ forkedFromThreadId: "s", forkedFromTitle: null, forkedAtEntryId: "a1" }),
    );
    expect(origin).toEqual({ kind: "source", threadId: "s", title: null, at: "a1" });
    expect(forkHint(origin)).toBe("Forked from “Untitled conversation”");
  });

  it("stays neutral without a source, and is null for a thread that is not a fork", () => {
    const hidden = forkOrigin(summary({ forkedFromThreadId: null, forkedAtEntryId: "a1" }));
    expect(hidden).toEqual({ kind: "hidden", at: "a1" });
    expect(forkHint(hidden)).toBe("Forked from a thread you can't open");
    expect(forkOrigin(summary({}))).toBeNull();
    expect(forkHint(null)).toBeUndefined();
  });
});
