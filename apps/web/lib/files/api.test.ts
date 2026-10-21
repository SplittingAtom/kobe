import { describe, expect, it } from "vitest";
import { must } from "../testing/must";
import { createFilesApi } from "./api";

interface Call {
  readonly url: string;
  readonly init: RequestInit;
}

function stub(status: number, body: unknown) {
  const calls: Call[] = [];
  const fetchFn: typeof fetch = async (input, init = {}) => {
    calls.push({ url: String(input), init });
    return new Response(body === undefined ? null : JSON.stringify(body), { status });
  };
  return { calls, fetchFn };
}

describe("files api", () => {
  it("lists a folder with the team header and camelized entries", async () => {
    const { calls, fetchFn } = stub(200, {
      path: "a b",
      entries: [
        { name: "x.txt", path: "a b/x.txt", type: "file", size_bytes: 3, area: "workspace" },
      ],
    });
    const res = await createFilesApi("t1", fetchFn).list("a b");
    expect(must(calls[0]).url).toBe("/v1/workspace/files?path=a+b");
    expect(new Headers(must(calls[0]).init.headers).get("x-kobe-team")).toBe("t1");
    expect(res.ok && res.data.entries[0]?.sizeBytes).toBe(3);
  });

  it("omits the path at the root and sends a cursor only when given", async () => {
    const { calls, fetchFn } = stub(200, { path: "", entries: [] });
    const api = createFilesApi("t1", fetchFn);
    await api.list("");
    await api.list("", "c1");
    expect(calls.map((c) => c.url)).toEqual([
      "/v1/workspace/files",
      "/v1/workspace/files?cursor=c1",
    ]);
  });

  it("uploads multipart with the folder and the file", async () => {
    const { calls, fetchFn } = stub(201, { name: "n.txt", path: "d/n.txt", type: "file" });
    await createFilesApi("t1", fetchFn).upload("d", new File(["hi"], "n.txt"));
    const call = must(calls[0]);
    expect(call.init.method).toBe("POST");
    const form = call.init.body as FormData;
    expect(form.get("path")).toBe("d");
    expect((form.get("file") as File).name).toBe("n.txt");
    expect(new Headers(call.init.headers).has("content-type")).toBe(false);
  });

  it("moves with a JSON body of both paths, naming the team (KOBE-304)", async () => {
    const { calls, fetchFn } = stub(200, { from: "a", to: "b/a", type: "dir", files: 2 });
    const api = createFilesApi("t1", fetchFn);
    expect(api.teamId).toBe("t1");
    const res = await api.move("a", "b/a");
    expect(res.ok && res.data).toEqual({ from: "a", to: "b/a", type: "dir", files: 2 });
    const call = must(calls[0]);
    expect(call.url).toBe("/v1/workspace/files/move");
    expect(call.init.method).toBe("POST");
    expect(JSON.parse(String(call.init.body))).toEqual({ from: "a", to: "b/a" });
    expect(new Headers(call.init.headers).get("x-kobe-team")).toBe("t1");
  });

  it("deletes by path and wakes", async () => {
    const del = stub(204, undefined);
    await createFilesApi("t1", del.fetchFn).remove("d/n.txt");
    expect(must(del.calls[0])).toMatchObject({ url: "/v1/workspace/files?path=d%2Fn.txt" });
    expect(must(del.calls[0]).init.method).toBe("DELETE");
    const wake = stub(202, { status: "waking" });
    const res = await createFilesApi("t1", wake.fetchFn).wake();
    expect(res.ok).toBe(true);
    expect(must(wake.calls[0])).toMatchObject({ url: "/v1/workspace/wake" });
  });

  it("downloads bytes", async () => {
    const fetchFn: typeof fetch = async () => new Response("abc");
    const res = await createFilesApi("t1", fetchFn).download("d/n.txt");
    expect(res.ok && new TextDecoder().decode(res.data)).toBe("abc");
  });

  it("reads at most maxBytes, says so, and reports the full size", async () => {
    const seen: string[] = [];
    const fetchFn: typeof fetch = async (input) => {
      seen.push(String(input));
      return new Response("abcdefgh", { headers: { "content-length": "8" } });
    };
    const api = createFilesApi("t1", fetchFn);
    const cut = await api.read("d/n.txt", 3);
    expect(cut.ok && { ...cut.data, bytes: new TextDecoder().decode(cut.data.bytes) }).toEqual({
      bytes: "abc",
      size: 8,
      truncated: true,
    });
    const whole = await api.read("d/n.txt", 8);
    expect(whole.ok && whole.data.truncated).toBe(false);
    expect(seen[0]).toBe("/v1/workspace/file?path=d%2Fn.txt");
    const missing = await createFilesApi("t1", stub(404, { code: "not_found" }).fetchFn).read(
      "x",
      3,
    );
    expect(!missing.ok && missing.error.code).toBe("not_found");
  });

  it("fetches nothing of a body whose Content-Length is over the cap", async () => {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(4));
      },
    });
    const fetchFn: typeof fetch = async () =>
      new Response(body, { headers: { "content-length": "8" } });
    const api = createFilesApi("t1", fetchFn);
    const res = await api.read("big", 0, true);
    expect(res.ok && res.data).toEqual({ bytes: new Uint8Array(0), size: 8, truncated: true });
    expect(pulled).toBeLessThanOrEqual(1); // at most the stream's own first pull
  });

  it("saves text at the version it was loaded at (KOBE-463, FE4) and reports a conflict", async () => {
    const base = "b".repeat(64);
    const ok = stub(200, {
      name: "n.md",
      path: "d/n.md",
      type: "file",
      size_bytes: 3,
      sha256: "c".repeat(64),
    });
    const res = await createFilesApi("t1", ok.fetchFn).save("d/n.md", base, "héllo");
    const call = must(ok.calls[0]);
    expect(call.url).toBe(`/v1/workspace/file?path=d%2Fn.md&base_sha256=${base}`);
    expect(call.init.method).toBe("PUT");
    expect(new Headers(call.init.headers).get("content-type")).toBe("text/plain; charset=utf-8");
    expect(new TextDecoder().decode(call.init.body as Uint8Array)).toBe("héllo");
    expect(res.ok && res.data.sha256).toBe("c".repeat(64));

    const conflict = stub(409, { code: "version_conflict", message: "Changed.", current: null });
    const failed = await createFilesApi("t1", conflict.fetchFn).save("d/n.md", base, "x");
    expect(!failed.ok && failed.error).toMatchObject({ status: 409, code: "version_conflict" });
  });
});
