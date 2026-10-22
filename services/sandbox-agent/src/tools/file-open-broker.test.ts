import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FileOpenResultFrame, KobeToolsRequest, KobeToolsResponse } from "@kobe/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PushPathError, type PushedFile } from "../workspace/sync.js";
import { FileOpenBroker, MAX_PENDING_OPENS_PER_THREAD } from "./file-open-broker.js";

const THREAD = "5b6c7d8e-9f0a-4b1c-8d2e-3f4a5b6c7d8e";
const RUN = "6c7d8e9f-0a1b-4c2d-9e3f-4a5b6c7d8e9f";
const SHA = "a".repeat(64);
const SETTLE_MS = 15_000;

type OpenRequest = Extract<KobeToolsRequest, { op: "file.open" }>;
const request = (p: string, id = "kt_1"): OpenRequest => ({
  id,
  op: "file.open",
  tool_call_id: `call_${id}`,
  tool: "open_file",
  input: { path: p },
});

let base: string;
let root: string;
beforeEach(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), "kobe-openbroker-")));
  root = path.join(base, "workspace");
  await mkdir(path.join(root, "notes"), { recursive: true });
  await writeFile(path.join(root, "notes", "plan.md"), "# Plan\n");
  await writeFile(path.join(base, "secret"), "x");
  await symlink(path.join(base, "secret"), path.join(root, "link"));
});
afterEach(() => rm(base, { recursive: true, force: true }));

function setup(options: { push?: ((rel: string) => Promise<PushedFile>) | null } = {}) {
  const frames: Record<string, unknown>[] = [];
  const order: string[] = [];
  const replies: KobeToolsResponse[] = [];
  const push =
    options.push === null
      ? undefined
      : (options.push ??
        (async (rel: string) => {
          order.push(`push:${rel}`);
          return { path: rel, rev: 1, sha256: SHA, size: 7 };
        }));
  const broker = new FileOpenBroker({
    root,
    send: (frame) => {
      order.push("send");
      frames.push(frame as unknown as Record<string, unknown>);
      return true;
    },
    pushPath: push,
  });
  const reply = (r: KobeToolsResponse) => replies.push(r);
  const settle = async (outcomes = 1) => {
    await vi.waitFor(() => expect(frames.length + replies.length).toBe(outcomes), {
      timeout: SETTLE_MS,
    });
    await new Promise((r) => setImmediate(r));
  };
  return { broker, frames, order, replies, reply, settle };
}

describe("FileOpenBroker (KOBE-484)", () => {
  it("pushes the file, then sends file.open with the agent's run and thread, and relays the answer", async () => {
    const { broker, frames, order, replies, reply, settle } = setup();
    broker.open(THREAD, RUN, request(`${root}/notes/plan.md`), reply);
    await settle();
    expect(order).toEqual(["push:notes/plan.md", "send"]);
    expect(frames[0]).toMatchObject({
      type: "file.open",
      run_id: RUN,
      thread_id: THREAD,
      tool_call_id: "call_kt_1",
      tool: "open_file",
      input: { path: `${root}/notes/plan.md` },
    });
    const result: FileOpenResultFrame = {
      v: 1,
      type: "file.open_result",
      request_id: frames[0]?.request_id as string,
      ok: true,
      op: "file_open",
      path: "notes/plan.md",
    };
    expect(broker.onResult(result)).toBe(true);
    expect(replies).toEqual([{ id: "kt_1", ok: true, op: "file_open", path: "notes/plan.md" }]);
    expect(broker.onResult(result)).toBe(false);
  });

  it("answers a missing file, a symlink or .kobe/ as a tool error and sends nothing", async () => {
    for (const [p, code] of [
      ["missing.md", "not_found"],
      ["link", "invalid_path"],
      [".kobe/state.json", "invalid_path"],
      ["../etc/passwd", "invalid_path"],
    ] as const) {
      const { broker, frames, replies, reply, settle } = setup();
      broker.open(THREAD, RUN, request(p), reply);
      await settle();
      expect(frames, p).toEqual([]);
      expect(replies[0], p).toMatchObject({ ok: false, error: { code } });
    }
  });

  it("still asks the server when the push fails or sync is off (it checks the synced copy)", async () => {
    for (const push of [() => Promise.reject(new PushPathError("too large")), null] as const) {
      const { broker, frames, reply, settle } = setup({ push });
      broker.open(THREAD, RUN, request("notes/plan.md"), reply);
      await settle();
      expect(frames[0]).toMatchObject({ type: "file.open", input: { path: "notes/plan.md" } });
    }
  });

  it("needs an active run, bounds requests per thread and fails pending ones when the run ends", async () => {
    const { broker, frames, replies, reply, settle } = setup();
    broker.open(THREAD, undefined, request("notes/plan.md", "kt_0"), reply);
    expect(replies[0]).toMatchObject({ ok: false, error: { code: "not_allowed" } });
    for (let i = 1; i <= MAX_PENDING_OPENS_PER_THREAD + 1; i++) {
      broker.open(THREAD, RUN, request("notes/plan.md", `kt_${i}`), reply);
    }
    await settle(MAX_PENDING_OPENS_PER_THREAD + 2);
    expect(frames).toHaveLength(MAX_PENDING_OPENS_PER_THREAD);
    expect(replies[1]).toMatchObject({ ok: false, error: { code: "unavailable" } });
    broker.failRun(RUN, "run ended");
    expect(replies).toHaveLength(MAX_PENDING_OPENS_PER_THREAD + 2);
  });
});
