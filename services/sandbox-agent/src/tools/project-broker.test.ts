import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  KobeToolsRequest,
  KobeToolsResponse,
  ProjectFileProposeResultFrame,
} from "@kobe/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PushPathError, type PushedFile } from "../workspace/sync.js";
import { ProjectFileBroker } from "./project-broker.js";

const THREAD = "5b6c7d8e-9f0a-4b1c-8d2e-3f4a5b6c7d8e";
const RUN = "6c7d8e9f-0a1b-4c2d-9e3f-4a5b6c7d8e9f";
const PROJECT = "7d8e9f0a-1b2c-4d3e-8f4a-5b6c7d8e9f0a";
const PROPOSAL = "8e9f0a1b-2c3d-4e4f-9a5b-6c7d8e9f0a1b";
const SHA = "a".repeat(64);

type ProposeRequest = Extract<KobeToolsRequest, { op: "project.file_propose" }>;
const request = (input: Record<string, unknown>, id = "kt_1"): ProposeRequest => ({
  id,
  op: "project.file_propose",
  tool_call_id: `call_${id}`,
  tool: "propose_project_file",
  input: input as ProposeRequest["input"],
});
const pending = (request_id: string): ProjectFileProposeResultFrame => ({
  v: 1,
  type: "project.file_propose_result",
  request_id,
  ok: true,
  op: "project_file_propose",
  status: "pending_approval",
  proposal_id: PROPOSAL,
  project_id: PROJECT,
  path: "docs/spec.md",
});

let base: string;
let root: string;
beforeEach(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), "kobe-projbroker-")));
  root = path.join(base, "workspace");
  await mkdir(path.join(root, "notes"), { recursive: true });
  await writeFile(path.join(root, "notes", "spec.md"), "# spec\n");
  await writeFile(path.join(base, "secret"), "x");
  await symlink(path.join(base, "secret"), path.join(root, "link"));
});
afterEach(() => rm(base, { recursive: true, force: true }));

function setup(options: { sends?: boolean; push?: (rel: string) => Promise<PushedFile> } = {}) {
  const frames: Record<string, unknown>[] = [];
  const order: string[] = [];
  const replies: KobeToolsResponse[] = [];
  const broker = new ProjectFileBroker({
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
        return { path: rel, rev: 4, sha256: SHA, size: 7 };
      }),
  });
  return {
    broker,
    frames,
    order,
    replies,
    reply: (r: KobeToolsResponse) => replies.push(r),
    settle: () => new Promise((r) => setTimeout(r, 20)),
  };
}

describe("ProjectFileBroker", () => {
  it("pushes first, then sends project.file_propose with the pushed entry, and relays the answer", async () => {
    const u = setup();
    u.broker.propose(
      THREAD,
      RUN,
      request({ path: `${root}/notes/spec.md`, folder: "docs" }),
      u.reply,
    );
    await u.settle();
    expect(u.order).toEqual(["push", "send"]);
    expect(u.frames).toEqual([
      {
        v: 1,
        type: "project.file_propose",
        request_id: "pf_1",
        run_id: RUN,
        thread_id: THREAD,
        tool_call_id: "call_kt_1",
        tool: "propose_project_file",
        input: { path: `${root}/notes/spec.md`, folder: "docs" },
        workspace: { path: "notes/spec.md", rev: 4, sha256: SHA, size: 7 },
      },
    ]);
    expect(u.broker.onResult(pending("pf_1"))).toBe(true);
    expect(u.replies).toEqual([
      {
        id: "kt_1",
        ok: true,
        op: "project_file_propose",
        status: "pending_approval",
        proposal_id: PROPOSAL,
        project_id: PROJECT,
        path: "docs/spec.md",
      },
    ]);
    expect(u.broker.pendingCount).toBe(0);
    expect(u.broker.onResult(pending("pf_1"))).toBe(false);
  });

  it("sends nothing for a path outside the workspace, a symlink, or a missing file", async () => {
    const u = setup();
    for (const [i, p] of ["/etc/passwd", "link", "notes/none.md", "../x"].entries()) {
      u.broker.propose(THREAD, RUN, request({ path: p }, `kt_${i}`), u.reply);
    }
    await u.settle();
    expect(u.order).toEqual([]);
    expect(u.replies).toHaveLength(4);
    for (const r of u.replies) expect(r).toMatchObject({ ok: false });
  });

  it("answers once when the push fails, the wire is down, or the run ends meanwhile", async () => {
    const failing = setup({
      push: () => Promise.reject(new PushPathError("changed while saving")),
    });
    failing.broker.propose(THREAD, RUN, request({ path: "notes/spec.md" }), failing.reply);
    await failing.settle();
    expect(failing.replies).toEqual([
      { id: "kt_1", ok: false, error: { code: "not_synced", message: "changed while saving" } },
    ]);

    const down = setup({ sends: false });
    down.broker.propose(THREAD, RUN, request({ path: "notes/spec.md" }), down.reply);
    await down.settle();
    expect(down.replies).toMatchObject([{ ok: false, error: { code: "unavailable" } }]);

    let release: (f: PushedFile) => void = () => undefined;
    const slow = setup({ push: () => new Promise<PushedFile>((r) => (release = r)) });
    slow.broker.propose(THREAD, RUN, request({ path: "notes/spec.md" }), slow.reply);
    slow.broker.failRun(RUN, "run ended");
    release({ path: "notes/spec.md", rev: 1, sha256: SHA, size: 7 });
    await slow.settle();
    expect(slow.frames).toEqual([]);
    expect(slow.replies).toMatchObject([{ ok: false, error: { code: "unavailable" } }]);
  });

  it("refuses without a run and caps what one thread has in flight", async () => {
    const u = setup({ push: () => new Promise<PushedFile>(() => undefined) });
    u.broker.propose(THREAD, undefined, request({ path: "notes/spec.md" }), u.reply);
    expect(u.replies).toMatchObject([{ ok: false, error: { code: "not_allowed" } }]);
    for (let i = 0; i < 5; i++) {
      u.broker.propose(THREAD, RUN, request({ path: "notes/spec.md" }, `kt_${i}`), u.reply);
    }
    expect(u.broker.pendingCount).toBe(4);
    expect(u.replies).toHaveLength(2);
    u.broker.failAll("gone");
    expect(u.broker.pendingCount).toBe(0);
  });
});
