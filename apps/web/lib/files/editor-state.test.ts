import { describe, expect, it, vi } from "vitest";
import {
  EditDraftStore,
  FileReviewStore,
  proposalFromEvent,
  type ProposalView,
} from "./editor-state";

const SHA = "a".repeat(64);
const proposal: ProposalView = {
  toolCallId: "call-1",
  path: "notes.md",
  baseSha256: SHA,
  content: "new\n",
  summary: "Rewrites the note",
};

describe("unsaved edits (KOBE-463)", () => {
  it("keeps a draft per path with the version it was based on, and says when any is unsaved", () => {
    const store = new EditDraftStore();
    const listener = vi.fn();
    store.subscribe(listener);
    expect(store.hasAny()).toBe(false);
    store.set("notes.md", { text: "draft", baseSha256: SHA });
    expect(store.get("notes.md")).toEqual({ text: "draft", baseSha256: SHA });
    expect(store.hasAny()).toBe(true);
    const before = store.get("notes.md");
    store.set("notes.md", { text: "draft", baseSha256: SHA });
    expect(store.get("notes.md")).toBe(before); // unchanged: no new snapshot
    store.clear("notes.md");
    expect(store.get("notes.md")).toBeUndefined();
    expect(store.hasAny()).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("moves a draft with its file (rename) and drops it when the file is gone", () => {
    const store = new EditDraftStore();
    store.set("a/notes.md", { text: "x", baseSha256: SHA });
    store.move("a", "b");
    expect(store.get("b/notes.md")?.text).toBe("x");
    expect(store.get("a/notes.md")).toBeUndefined();
  });
});

describe("proposals under review", () => {
  it("one review per file; the newest Review wins and the outcome is remembered per call", () => {
    const store = new FileReviewStore();
    store.start(proposal);
    expect(store.reviewOf("notes.md")).toBe(proposal);
    const second = { ...proposal, toolCallId: "call-2" };
    store.start(second);
    expect(store.reviewOf("notes.md")).toBe(second);
    store.finish("notes.md", "committed");
    expect(store.reviewOf("notes.md")).toBeUndefined();
    expect(store.outcomeOf("call-2")).toBe("committed");
    expect(store.outcomeOf("call-1")).toBeUndefined();
  });

  it("reads the stream's snake_case payload as the same view the list route gives", () => {
    expect(
      proposalFromEvent({
        tool_call_id: "call-1",
        path: "notes.md",
        base_sha256: SHA,
        content: "new\n",
        summary: "Rewrites the note",
      }),
    ).toEqual(proposal);
  });
});
