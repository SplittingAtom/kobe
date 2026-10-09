import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FileShareResultFrame, KobeToolsRequest, KobeToolsResponse } from "@kobe/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PushPathError, type PushedFile } from "../workspace/sync.js";
import { FileShareBroker, MAX_PENDING_SHARES_PER_THREAD } from "./share-broker.js";

const THREAD = "5b6c7d8e-9f0a-4b1c-8d2e-3f4a5b6c7d8e";
const RUN = "6c7d8e9f-0a1b-4c2d-9e3f-4a5b6c7d8e9f";
const FILE_ID = "7d8e9f0a-1b2c-4d3e-8f4a-5b6c7d8e9f0a";
const SHA = "a".repeat(64);

type ShareRequest = Extract<KobeToolsRequest, { op: "file.share" }>;
const request = (input: Record<string, unknown>, id = "kt_1"): ShareRequest => ({
  id,
  op: "file.share",
  tool_call_id: `call_${id}`,
  tool: "share_file",
  input: input as ShareRequest["input"],
});
const okResult = (request_id: string): FileShareResultFrame => ({
  v: 1,
  type: "file.share_result",
  request_id,
  ok: true,
  file_id: FILE_ID,
  name: "report.csv",
  mime_type: "text/csv",
  size_bytes: 8,
  scan: "clean",
  created_at: "2026-10-09T10:00:00.000Z",
  sha256: SHA,
});

let base: string;
let root: string;
beforeEach(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), "kobe-sharebroker-")));
  root = path.join(base, "workspace");
  await mkdir(path.join(root, "out"), { recursive: true });
  await writeFile(path.join(root, "out", "report.csv"), "a,b\n1,2\n");
  await writeFile(path.join(base, "secret"), "x");
  await symlink(path.join(base, "secret"), path.join(root, "link"));
});
afterEach(() => rm(base, { recursive: true, force: true }));

function setup(options: { sends?: boolean; push?: (rel: string) => Promise<PushedFile> } = {}) {
  const frames: Record<string, unknown>[] = [];
  const pushed: string[] = [];
  const order: string[] = [];
  const replies: KobeToolsResponse[] = [];
  const broker = new FileShareBroker({
    root,
    send: (frame) => {
      order.push("send");
      frames.push(frame as unknown as Record<string, unknown>);
      return options.sends ?? true;
    },
    pushPath:
      options.push ??
      (async (rel) => {
        order.push("push");
        pushed.push(rel);
        return { path: rel, rev: 3, sha256: SHA, size: 8 };
      }),
  });
  const reply = (r: KobeToolsResponse) => replies.push(r);
  const settle = () => new Promise((r) => setTimeout(r, 20));
  return { broker, frames, pushed, order, replies, reply, settle };
}

describe("FileShareBroker", () => {
  it("pushes first, then sends file.share with the pushed entry, and returns the result", async () => {
    const u = setup();
    u.broker.share(THREAD, RUN, request({ path: `${root}/out/report.csv`, name: "r.csv" }), u.reply);
    await u.settle();
    expect(u.order).toEqual(["push", "send"]);
    expect(u.pushed).toEqual(["out/report.csv"]);
    expect(u.frames).toEqual([
      {
        v: 1,
        type: "file.share",
        request_id: "fs_1",
        run_id: RUN,
        thread_id: THREAD,
        tool_call_id: "call_kt_1",
        tool: "share_file",
        input: { path: `${root}/out/report.csv`, name: "r.csv" },
        workspace: { path: "out/report.csv", rev: 3, sha256: SHA, size: 8 },
      },
    ]);
    expect(u.broker.onResult(okResult("fs_1"))).toBe(true);
    expect(u.replies).toEqual([
      {
        id: "kt_1",
        ok: true,
        file_id: FILE_ID,
        name: "report.csv",
        mime_type: "text/csv",
        size_bytes: 8,
        scan: "clean",
        created_at: "2026-10-09T10:00:00.000Z",
        sha256: SHA,
      },
    ]);
    expect(u.broker.pendingCount).toBe(0);
  });

  it("turns a server error into a tool error", async () => {
    const t = setup();
    t.broker.share(THREAD, RUN, request({ path: "out/report.csv" }), t.reply);
    await t.settle();
    t.broker.onResult({
      v: 1,
      type: "file.share_result",
      request_id: "fs_1",
      ok: false,
      error: { code: "quota_exceeded", message: "no room" },
    });
    expect(t.replies).toEqual([
      { id: "kt_1", ok: false, error: { code: "quota_exceeded", message: "no room" } },
    ]);
  });

  it("returns a clear not_synced error when the push fails, and sends nothing", async () => {
    const t = setup({
      push: async () => {
        throw new PushPathError("out/report.csv could not be pushed to the Kobe server");
      },
    });
    t.broker.share(THREAD, RUN, request({ path: "out/report.csv" }), t.reply);
    await t.settle();
    expect(t.frames).toEqual([]);
    expect(t.replies).toEqual([
      {
        id: "kt_1",
        ok: false,
        error: { code: "not_synced", message: "out/report.csv could not be pushed to the Kobe server" },
      },
    ]);
    expect(t.broker.pendingCount).toBe(0);
  });

  it("an unexpected push failure is a not_synced error too (fail closed)", async () => {
    const t = setup({ push: async () => Promise.reject(new Error("boom /secret/detail")) });
    t.broker.share(THREAD, RUN, request({ path: "out/report.csv" }), t.reply);
    await t.settle();
    expect(t.frames).toEqual([]);
    expect(t.replies[0]).toMatchObject({ ok: false, error: { code: "not_synced" } });
    expect(JSON.stringify(t.replies)).not.toContain("/secret/detail");
  });

  it.each([
    ["traversal", "../secret", "invalid_path"],
    ["outside", "/etc/passwd", "invalid_path"],
    ["a symlink out", "link", "invalid_path"],
    ["excluded", ".kobe/sessions/x", "invalid_path"],
    ["a missing file", "out/none.csv", "not_found"],
  ])("refuses %s before pushing anything", async (_n, p, code) => {
    const t = setup();
    t.broker.share(THREAD, RUN, request({ path: p }), t.reply);
    await t.settle();
    expect(t.pushed).toEqual([]);
    expect(t.frames).toEqual([]);
    expect(t.replies).toEqual([
      { id: "kt_1", ok: false, error: { code, message: expect.any(String) } },
    ]);
  });

  it("refuses without an active run", async () => {
    const t = setup();
    t.broker.share(THREAD, undefined, request({ path: "out/report.csv" }), t.reply);
    await t.settle();
    expect(t.pushed).toEqual([]);
    expect(t.replies[0]).toMatchObject({ ok: false, error: { code: "not_allowed" } });
  });

  it("reports an unreachable server and forgets the request", async () => {
    const t = setup({ sends: false });
    t.broker.share(THREAD, RUN, request({ path: "out/report.csv" }), t.reply);
    await t.settle();
    expect(t.replies[0]).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(t.broker.pendingCount).toBe(0);
  });

  it("caps requests in flight per thread", async () => {
    const t = setup({ push: () => new Promise(() => {}) });
    for (let i = 0; i <= MAX_PENDING_SHARES_PER_THREAD; i++) {
      t.broker.share(THREAD, RUN, request({ path: "out/report.csv" }, `kt_${i}`), t.reply);
    }
    await t.settle();
    expect(t.replies).toEqual([
      expect.objectContaining({ ok: false, error: expect.objectContaining({ code: "unavailable" }) }),
    ]);
  });

  it("answers a request once when the run ends during the push, and never sends afterwards", async () => {
    let release: (f: PushedFile) => void = () => {};
    const t = setup({ push: () => new Promise((r) => (release = r)) });
    t.broker.share(THREAD, RUN, request({ path: "out/report.csv" }), t.reply);
    await t.settle();
    t.broker.failRun(RUN, "run ended");
    release({ path: "out/report.csv", rev: 1, sha256: SHA, size: 8 });
    await t.settle();
    expect(t.frames).toEqual([]);
    expect(t.replies).toHaveLength(1);
    expect(t.replies[0]).toMatchObject({ ok: false, error: { code: "unavailable" } });
  });

  it("fails what waits for the server when the connection is lost; a late result is ignored", async () => {
    const t = setup();
    t.broker.share(THREAD, RUN, request({ path: "out/report.csv" }), t.reply);
    await t.settle();
    t.broker.failAll("connection to Kobe server lost");
    expect(t.replies).toHaveLength(1);
    expect(t.broker.onResult(okResult("fs_1"))).toBe(false);
    expect(t.replies).toHaveLength(1);
  });

  it("ignores a result nobody waits for", () => {
    expect(setup().broker.onResult(okResult("fs_99"))).toBe(false);
  });
});
