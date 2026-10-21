import { describe, expect, it } from "vitest";
import { must } from "../testing/must";
import { createNotebookApi, outputFrameUrl } from "./api";

function stub(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn: typeof fetch = async (input, init = {}) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify(body), { status });
  };
  return { calls, fetchFn };
}

describe("notebook api (KOBE-465)", () => {
  it("runs a cell with the team header and reads run and exec ids", async () => {
    const { calls, fetchFn } = stub(202, { run_id: "r1", exec_id: "e1" });
    const api = createNotebookApi("t1", fetchFn);
    const res = await api.run("th/1", { path: "a.ipynb", cell_id: "c1" });
    expect(res).toMatchObject({ ok: true, data: { runId: "r1", execId: "e1" } });
    const call = must(calls[0]);
    expect(call.url).toBe("/v1/threads/th%2F1/notebook/run");
    expect(call.init.method).toBe("POST");
    expect(new Headers(call.init.headers).get("x-kobe-team")).toBe("t1");
    expect(JSON.parse(String(call.init.body))).toEqual({ path: "a.ipynb", cell_id: "c1" });
  });

  it("interrupts and restarts the kernel", async () => {
    const { calls, fetchFn } = stub(200, { status: "no_kernel" });
    const api = createNotebookApi("t1", fetchFn);
    expect(await api.kernel("th", "interrupt")).toMatchObject({ data: { status: "no_kernel" } });
    await api.kernel("th", "restart");
    expect(calls.map((c) => c.url)).toEqual([
      "/v1/threads/th/notebook/interrupt",
      "/v1/threads/th/notebook/restart",
    ]);
  });

  it("passes server errors through", async () => {
    const { fetchFn } = stub(409, { code: "thread_busy", message: "busy" });
    const res = await createNotebookApi("t1", fetchFn).run("th", { path: "a.py" });
    expect(res).toMatchObject({ ok: false, error: { code: "thread_busy", status: 409 } });
  });

  it("names the output frame route with the team", () => {
    expect(outputFrameUrl("t 1")).toBe("/v1/workspace/output-frame?team=t+1");
  });
});
