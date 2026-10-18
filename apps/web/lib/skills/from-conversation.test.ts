import { describe, expect, it, vi } from "vitest";
import type { ChatApi } from "../chat/api";
import type { UploadRequest } from "../chat/uploads";
import { SOURCE_FILE, skillPrompt, startSkillFromConversation } from "./from-conversation";

/** KOBE-322 (SK10 start 2): a Kobe-agent thread with the source attached and skill-creator asked. */
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
  it("opens a Kobe conversation, attaches the source read-only and asks skill-creator", async () => {
    const api = fakeApi([{ id: "a-team" }, { id: "a-kobe", galleryKey: "kobe" }]);
    const upload = vi.fn(async (_request: UploadRequest) => ({
      ok: true as const,
      file: { fileId: "f-1", name: SOURCE_FILE, mimeType: "text/markdown", sizeBytes: 10 },
    }));
    const res = await startSkillFromConversation(
      { api, teamId: "t-1", upload, newKey: () => "k-1" },
      { threadId: "s-1", title: "Monthly close" },
    );
    expect(res).toEqual({ ok: true, status: 201, data: { threadId: "w-1" } });
    expect(api.createThread).toHaveBeenCalledWith("Skill from: Monthly close", null, {
      agentId: "a-kobe",
      test: false,
    });
    const sent = upload.mock.calls[0]?.[0];
    expect([sent?.file.name, sent?.threadId]).toEqual([SOURCE_FILE, "w-1"]);
    expect(api.sendMessage).toHaveBeenCalledWith(
      "w-1",
      { content: skillPrompt("Monthly close"), fileIds: ["f-1"] },
      "k-1",
    );
    expect(skillPrompt("x")).toMatch(/skill-creator.*\/workspace\/skills\/<name>\//);
  });

  it("refuses when the team has no Kobe agent", async () => {
    const api = fakeApi([{ id: "a-team" }]);
    const res = await startSkillFromConversation(
      { api, teamId: "t-1", upload: vi.fn(), newKey: () => "k" },
      { threadId: "s-1", title: "T" },
    );
    expect(res.ok).toBe(false);
    expect(api.createThread).not.toHaveBeenCalled();
  });
});
