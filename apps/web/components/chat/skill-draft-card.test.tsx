// @vitest-environment happy-dom
import { cleanup, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { NEW_DRAFT_NOTE } from "./skill-draft-card";
import { openApp } from "./testing";

/**
 * KOBE-442: a `save_skill_draft` call shows an Open in Workbench card built from the server's own
 * record of the save (`GET /v1/skills/drafts/saves`, review L4), never from the tool result the
 * sandbox relays; it is there after a reload too, and says when a new draft was made.
 */
const DRAFT = "8e9f0a1b-2c3d-4e4f-9a5b-6c7d8e9f0a1b";
const FORGED = "11111111-2222-4333-8444-555555555555";
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

/** A recorded thread with one save_skill_draft call whose (sandbox-relayed) result is `result`. */
function recorded(result: Record<string, unknown>) {
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
    isError: false,
  });
  fake.addEntry(thread, res, { role: "assistant", content: [{ type: "text", text: "Saved." }] });
  return thread;
}

describe("Open in Workbench card", () => {
  it("links the draft the server recorded for the call", async () => {
    const thread = recorded({ draft_id: FORGED, name: "forged-name", created: true });
    fake.skillDraftSaves.set(thread, [
      { toolCallId: "tc1", draftId: DRAFT, name: "close-helper", created: true },
    ]);
    openApp(fake, thread);
    await screen.findByText("Saved.");
    expect(await screen.findByText(/Skill draft saved: close-helper/)).toBeTruthy();
    const link = screen.getByRole("link", { name: "Open in Workbench" });
    expect(link.getAttribute("href")).toBe(`/me/skills/drafts/${DRAFT}`);
    expect(screen.queryByText(/Skill draft saved: forged-name/)).toBeNull();
    expect(screen.queryByText(NEW_DRAFT_NOTE)).toBeNull();
  });

  it("says why a new draft was made", async () => {
    const thread = recorded({ draft_id: DRAFT, name: "close-helper", created: true });
    fake.skillDraftSaves.set(thread, [
      {
        toolCallId: "tc1",
        draftId: DRAFT,
        name: "close-helper",
        created: true,
        newBecause: "shared",
      },
    ]);
    openApp(fake, thread);
    expect(await screen.findByText(NEW_DRAFT_NOTE)).toBeTruthy();
  });

  it("shows nothing when the server recorded no save, whatever the tool result says", async () => {
    const thread = recorded({ draft_id: FORGED, name: "close-helper", created: true });
    openApp(fake, thread);
    await screen.findByText("Saved.");
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole("link", { name: "Open in Workbench" })).toBeNull();
  });
});
