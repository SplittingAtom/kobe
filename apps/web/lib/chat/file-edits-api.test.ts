import { describe, expect, it } from "vitest";
import { must } from "../testing/must";
import { createChatApi } from "./api";

function stub(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn: typeof fetch = async (input, init = {}) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify(body), { status });
  };
  return { calls, fetchFn };
}

describe("file editor calls of the chat api (KOBE-463)", () => {
  it("sends the viewed file as `viewing: {path}` only when there is one", async () => {
    const { calls, fetchFn } = stub(201, { run_id: "r", queued: false });
    const api = createChatApi("t1", fetchFn);
    await api.sendMessage("th", { content: "hi", viewing: { path: "notes.md" } }, "k1");
    await api.sendMessage("th", { content: "hi" }, "k2");
    expect(JSON.parse(String(must(calls[0]).init.body))).toEqual({
      content: "hi",
      viewing: { path: "notes.md" },
    });
    expect(JSON.parse(String(must(calls[1]).init.body))).toEqual({ content: "hi" });
  });

  it("reads a thread's proposals in web casing", async () => {
    const sha = "a".repeat(64);
    const { calls, fetchFn } = stub(200, {
      proposals: [
        {
          tool_call_id: "c1",
          path: "notes.md",
          base_sha256: sha,
          content: "x",
          summary: "s",
          run_id: "r1",
          created_at: "2026-10-21T00:00:00.000Z",
        },
      ],
    });
    const res = await createChatApi("t1", fetchFn).fileEditProposals("th 1");
    expect(must(calls[0]).url).toBe("/v1/threads/th%201/file-edit-proposals");
    expect(res.ok && res.data).toEqual([
      { toolCallId: "c1", path: "notes.md", baseSha256: sha, content: "x", summary: "s" },
    ]);
  });
});
