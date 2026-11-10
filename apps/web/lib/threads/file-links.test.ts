import { describe, expect, it, vi } from "vitest";
import { batches, createFileLinksApi } from "./file-links";

const answer = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("createFileLinksApi", () => {
  it("reads the rows' links in one request and camelizes them", async () => {
    const fetchFn = vi.fn(async () =>
      answer({
        links: [
          {
            thread_id: "t1",
            files: [
              { path: "a,b.md", project_id: null, access: "write", last_at: "x", deleted: false },
            ],
            hidden_count: 2,
          },
        ],
      }),
    );
    const api = createFileLinksApi("team", fetchFn as unknown as typeof fetch);
    const res = await api.threadFileLinks(["t1", "t2"]);
    expect(res).toMatchObject({
      ok: true,
      data: [{ threadId: "t1", hiddenCount: 2, files: [{ path: "a,b.md", access: "write" }] }],
    });
    const url = String((fetchFn.mock.calls[0] as unknown[])[0]);
    expect(url).toContain("/v1/threads/file-links?threads=t1,t2");
  });

  it("encodes each path (commas too) and refuses a malformed answer", async () => {
    const fetchFn = vi.fn(async () => answer({ files: [{ path: "x", threads: "nope" }] }));
    const api = createFileLinksApi("team", fetchFn as unknown as typeof fetch);
    const res = await api.fileThreads(["a,b.md", "c d"]);
    expect(res).toMatchObject({ ok: false, error: { code: "malformed_response" } });
    expect(String((fetchFn.mock.calls[0] as unknown[])[0])).toContain("paths=a%2Cb.md,c%20d");
  });

  it("reads one thread's links; asks nothing for no ids; refuses over the cap", async () => {
    const fetchFn = vi.fn(async () => answer({ thread_id: "t", files: [], hidden_count: 0 }));
    const api = createFileLinksApi("team", fetchFn as unknown as typeof fetch);
    expect(await api.threadFileList("t")).toMatchObject({ ok: true, data: { threadId: "t" } });
    expect(await api.threadFileLinks([])).toMatchObject({ ok: true, data: [] });
    expect(await api.fileThreads([])).toMatchObject({ ok: true, data: [] });
    const many = Array.from({ length: 51 }, (_, i) => `t${i}`);
    expect(await api.threadFileLinks(many)).toMatchObject({ ok: false });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("batches", () => {
    expect(batches([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
});
