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
      entries: [{ name: "x.txt", path: "a b/x.txt", type: "file", size_bytes: 3, area: "workspace" }],
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
    expect(calls.map((c) => c.url)).toEqual(["/v1/workspace/files", "/v1/workspace/files?cursor=c1"]);
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
});
