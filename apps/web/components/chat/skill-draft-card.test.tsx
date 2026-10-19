// @vitest-environment happy-dom
import { cleanup, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { skillDraftFromToolResult } from "../../lib/skills/draft-tool-result";
import { openApp } from "./testing";

/**
 * KOBE-442: a `save_skill_draft` call shows an Open in Workbench card from its result, so it is
 * there after a reload too (no event needed).
 */
const DRAFT = "8e9f0a1b-2c3d-4e4f-9a5b-6c7d8e9f0a1b";
let fake: FakeKobe;

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  fake = new FakeKobe();
  vi.stubGlobal("fetch", fake.fetch);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function recorded(result: Record<string, unknown>, isError = false) {
  const thread = fake.addThread("Close helper");
  const prompt = fake.addEntry(thread, null, { role: "user", content: "Save it" });
  const call = fake.addEntry(thread, prompt, {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: "tc1",
        name: "save_skill_draft",
        arguments: { folder: "close-helper" },
      },
    ],
  });
  const res = fake.addEntry(thread, call, {
    role: "toolResult",
    toolCallId: "tc1",
    toolName: "save_skill_draft",
    content: [{ type: "text", text: JSON.stringify(result) }],
    isError,
  });
  fake.addEntry(thread, res, { role: "assistant", content: [{ type: "text", text: "Saved." }] });
  return thread;
}

describe("skillDraftFromToolResult", () => {
  it("reads the draft from the tool's JSON text, and nothing else", () => {
    const ok = { draft_id: DRAFT, name: "close-helper", created: false, rev: 3, file_count: 2 };
    expect(skillDraftFromToolResult(JSON.stringify(ok))).toEqual({
      draftId: DRAFT,
      name: "close-helper",
      created: false,
    });
    expect(skillDraftFromToolResult(ok)).toMatchObject({ draftId: DRAFT });
    expect(skillDraftFromToolResult("not json")).toBeUndefined();
    expect(skillDraftFromToolResult({ ...ok, draft_id: "../x" })).toBeUndefined();
    expect(skillDraftFromToolResult({ ...ok, name: 3 })).toBeUndefined();
    expect(skillDraftFromToolResult(undefined)).toBeUndefined();
  });
});

describe("Open in Workbench card", () => {
  it("links the saved draft from a recorded save_skill_draft call", async () => {
    const thread = recorded({
      draft_id: DRAFT,
      name: "close-helper",
      created: true,
      rev: 1,
      file_count: 2,
      next: "Tell the user…",
    });
    openApp(fake, thread);
    await screen.findByText("Saved.");
    expect(screen.getByText(/Skill draft saved: close-helper/)).toBeTruthy();
    const link = screen.getByRole("link", { name: "Open in Workbench" });
    expect(link.getAttribute("href")).toBe(`/me/skills/drafts/${DRAFT}`);
  });

  it("shows no card for a failed save", async () => {
    const thread = recorded({ error: "invalid_skill: SKILL.md has no description." }, true);
    openApp(fake, thread);
    await screen.findByText("Saved.");
    expect(screen.queryByRole("link", { name: "Open in Workbench" })).toBeNull();
  });
});
