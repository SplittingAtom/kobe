import { describe, expect, it, vi } from "vitest";
import type { ChatApi } from "../chat/api";
import { SOURCE_FILE, skillPrompt, startSkillFromConversation } from "./from-conversation";

/**
 * KOBE-322 (SK10 start 2): a Kobe-agent thread with the source attached and the request to
 * skill-creator in its composer, not sent: the member reads it and sends it (coordinator).
 */
function fakeApi(agents: { id: string; galleryKey?: string }[]) {
  const api = {
    getThread: vi.fn(async () => ({
      ok: true,
      status: 200,
      data: { entries: [], nextEntriesAfter: null, leafEntryId: null },
    })),
    listEntries: vi.fn(),
    toolOutput: vi.fn(),
    runnableAgents: vi.fn(async () => ({
      ok: true,
      status: 200,
      data: agents.map((a) => ({ ...a, scope: "gallery", name: a.id, model: null })),
    })),
    createThread: vi.fn(async () => ({ ok: true, status: 201, data: { threadId: "w-1" } })),
    sendMessage: vi.fn(async () => ({ ok: true, status: 201, data: {} })),
  };
  return api as typeof api & ChatApi;
}

describe("startSkillFromConversation", () => {
  it("opens a Kobe conversation, attaches the source and prefills the request without sending", async () => {
    const api = fakeApi([{ id: "a-team" }, { id: "a-kobe", galleryKey: "kobe" }]);
    const attach = vi.fn();
    const prefill = vi.fn();
    const res = await startSkillFromConversation(
      { api, attach, prefill },
      { threadId: "s-1", title: "Monthly close" },
    );
    expect(res).toEqual({ ok: true, status: 201, data: { threadId: "w-1" } });
    expect(api.createThread).toHaveBeenCalledWith("Skill from: Monthly close", null, {
      agentId: "a-kobe",
      test: false,
    });
    const [thread, file] = attach.mock.calls[0] ?? [];
    expect([thread, (file as File | undefined)?.name]).toEqual(["w-1", SOURCE_FILE]);
    expect(prefill).toHaveBeenCalledWith("w-1", skillPrompt("Monthly close"));
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(skillPrompt("x")).toMatch(/skill-creator.*\/workspace\/skills\/<name>\//);
    // KOBE-442: skill-creator saves the draft itself; the menu is the fallback.
    expect(skillPrompt("x")).toMatch(/save it to my Workbench as a draft/);
    expect(skillPrompt("x")).not.toMatch(/I will save it/);
  });

  it("refuses when the team has no Kobe agent", async () => {
    const api = fakeApi([{ id: "a-team" }]);
    const res = await startSkillFromConversation(
      { api, attach: vi.fn(), prefill: vi.fn() },
      { threadId: "s-1", title: "T" },
    );
    expect(res.ok).toBe(false);
    expect(api.createThread).not.toHaveBeenCalled();
  });
});
