import { describe, expect, it } from "vitest";
import type { ThreadSummary } from "../../lib/chat/types";
import { showsEditingMarks } from "./use-conversation-project";

// Only the share fields matter to the rule (the same shortcut as head.test.ts).
const summary = (over: Partial<ThreadSummary>): ThreadSummary =>
  ({ threadId: "t1", projectId: "p1", sharedToProject: false, ...over }) as ThreadSummary;

describe("editing marks in the Files panel (FP3, amended 2026-11-10)", () => {
  it("shows them in a conversation in a project shared with the project or the team", () => {
    expect(showsEditingMarks("p1", summary({ visibility: "project" }))).toBe(true);
    expect(showsEditingMarks("p1", summary({ visibility: "team" }))).toBe(true);
  });

  it("hides them in a private conversation, with or without a project", () => {
    expect(showsEditingMarks("p1", summary({ visibility: "private" }))).toBe(false);
    expect(showsEditingMarks(null, summary({ projectId: null, visibility: "team" }))).toBe(false);
  });

  it("reads an older answer's shared_to_project when visibility is absent", () => {
    expect(showsEditingMarks("p1", summary({ sharedToProject: true }))).toBe(true);
    expect(showsEditingMarks("p1", summary({ sharedToProject: false }))).toBe(false);
  });
});
