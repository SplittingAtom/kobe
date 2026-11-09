import { chmod, lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { SandboxToServerFrame } from "@kobe/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeSyncServer } from "./testing/fake-sync-server.js";
import { RUN, RUN_2, runStart, startHarness, until, type Harness } from "./testing/harness.js";
import {
  FAUX_MODEL_EXTENSION,
  PI_AVAILABLE,
  PI_BIN,
  REAL_POLICY_EXTENSION,
  REAL_TOOLS_EXTENSION,
  fauxScript,
} from "./testing/real-pi.js";
import { SyncClient } from "./workspace/client.js";
import { WorkspaceSync } from "./workspace/sync.js";

/**
 * KOBE-580 (Workspaces WS-5) against the REAL pinned Pi with the real kobe-policy and kobe-tools,
 * through kobe-sandbox-agent, a fake Kobe server (wire) and a fake workspace-sync server (HTTP;
 * it lists the member's checkouts and accepts `projects/<slug>/` only for them, as KOBE-579's
 * server will):
 *  - ac-1: Pi's own tools write a checked-out project folder and the push carries it; the same
 *    write in a read-only project folder fails on the file's permissions; once the checkout is
 *    gone from the pull the folder is relocked and matches the head.
 *  - ac-2: `commit_project` is listed only when `run.start.project.access` is `write`; kobe-policy
 *    decides first and a refusal reaches the model with its reason; an allowed call pushes the
 *    working copy, then sends `project.commit`, and the server's answer is the tool result.
 */
type PiEventFrame = Extract<SandboxToServerFrame, { type: "pi.event" }>;
type CheckFrame = Extract<SandboxToServerFrame, { type: "policy.check" }>;
type CommitFrame = Extract<SandboxToServerFrame, { type: "project.commit" }>;

const PROJECT = {
  id: "11111111-1111-4111-8111-111111111111",
  slug: "acme",
  name: "Acme",
  instructions: "",
  mount: "/workspace/projects/acme",
};
const CHECKOUT = { project_id: PROJECT.id, slug: "acme", base_commit_seq: 1 };

const sync = new FakeSyncServer();
let syncUrl: string;
let h: Harness | undefined;
let ws: WorkspaceSync | undefined;

beforeEach(async () => {
  syncUrl = await sync.start();
  sync.serverWrite("projects/acme/brief.md", "v1\n");
  sync.serverWrite("projects/other/readme.md", "other\n");
});
/** Read-only project folders are 0555: make them removable for the harness's cleanup. */
async function chmodTree(dir: string): Promise<void> {
  await chmod(dir, 0o755).catch(() => {});
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (e.isDirectory()) await chmodTree(path.join(dir, e.name));
  }
}

afterEach(async () => {
  try {
    expect(h?.server.violations ?? []).toEqual([]);
    await ws?.flush(10);
    if (h !== undefined) await chmodTree(h.workspace);
    await h?.close();
  } finally {
    h = undefined;
    ws = undefined;
    await sync.stop();
    sync.rows.clear();
    sync.blobs.clear();
    sync.checkouts.length = 0;
  }
});

async function start(): Promise<{ t: Harness; s: WorkspaceSync }> {
  h = await startHarness({
    piBin: PI_BIN,
    env: { KOBE_POLICY_EXTENSION: REAL_POLICY_EXTENSION },
    extensions: [FAUX_MODEL_EXTENSION],
    toolsExtension: REAL_TOOLS_EXTENSION,
    workspace: (dir: string) => {
      ws = new WorkspaceSync({
        root: dir,
        client: new SyncClient({ serverUrl: syncUrl, readToken: async () => sync.token }),
        logger: { debug() {}, info() {}, warn() {} },
        intervalMs: 60_000,
      });
      ws.start();
      return ws;
    },
  });
  await ws?.ready();
  return { t: h, s: ws as WorkspaceSync };
}

const checks = (t: Harness) => t.server.frames("policy.check") as CheckFrame[];
const commits = (t: Harness) => t.server.frames("project.commit") as CommitFrame[];
const events = (t: Harness) =>
  (t.server.frames("pi.event") as PiEventFrame[]).map((f) => f.event as Record<string, unknown>);

function decide(t: Harness, check: CheckFrame, decision: "allow" | "deny", message = "") {
  t.server.send({
    v: 1,
    type: "policy.result",
    request_id: check.request_id,
    run_id: check.run_id,
    tool_call_id: check.tool_call_id,
    decision,
    reasons: [
      decision === "allow"
        ? { code: "user_allow_rule", stage: "user_allow", message: "allowed" }
        : { code: "approval_required", stage: "default", message },
    ],
    ...(decision === "deny" ? { message } : {}),
  } as never);
}

async function toolEnd(t: Harness, toolCallId: string) {
  await until(
    () => events(t).some((e) => e.type === "tool_execution_end" && e.toolCallId === toolCallId),
    30_000,
  );
  const end = events(t).find(
    (e) => e.type === "tool_execution_end" && e.toolCallId === toolCallId,
  ) as { isError: boolean; result: { content: { text: string }[] } };
  return { isError: end.isError, text: end.result.content.map((c) => c.text).join("") };
}

/** Starts a run playing `steps`; each tool call is allowed as its check arrives, unless `hold`. */
async function play(
  t: Harness,
  runId: string,
  steps: Record<string, unknown>[],
  project: Record<string, unknown> = { ...PROJECT, access: "write" },
) {
  const result = await t.server.command(
    runStart(fauxScript(steps), { run_id: runId, project }),
    30_000,
  );
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
}

async function allowNext(t: Harness, index: number): Promise<CheckFrame> {
  await until(() => checks(t).length > index, 30_000);
  const check = checks(t)[index] as CheckFrame;
  decide(t, check, "allow");
  return check;
}

const systemText = async (t: Harness, before: number): Promise<string> => {
  const texts = () =>
    events(t).flatMap((e) => {
      const m = e.message as { role?: string; content?: { text?: string }[] } | undefined;
      if (e.type !== "message_end" || m?.role !== "assistant" || !Array.isArray(m.content)) {
        return [];
      }
      return m.content.map((b) => b.text ?? "").filter((x) => x.startsWith("SYSTEM:"));
    });
  await until(() => texts().length > before, 30_000);
  return texts()[before] as string;
};

const modeOf = async (t: Harness, rel: string) =>
  (await lstat(path.join(t.workspace, rel))).mode & 0o777;

describe.skipIf(!PI_AVAILABLE)("project checkouts and commit_project in real Pi (KOBE-580)", () => {
  it("ac-1: writes in a checkout are pushed, a read-only project refuses them, and an ended checkout is relocked to the head", async () => {
    sync.checkouts.push(CHECKOUT);
    const { t, s } = await start();
    const acme = path.join(t.workspace, "projects/acme/brief.md");
    const other = path.join(t.workspace, "projects/other/readme.md");
    await play(t, RUN, [
      { tool: "write", id: "w1", args: { path: acme, content: "v2 by the agent\n" } },
      { tool: "write", id: "w2", args: { path: other, content: "vandalised\n" } },
    ]);
    await allowNext(t, 0);
    expect(await toolEnd(t, "w1")).toMatchObject({ isError: false });
    await allowNext(t, 1);
    const refused = await toolEnd(t, "w2");
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/EACCES|permission denied/i);
    expect(await readFile(other, "utf8")).toBe("other\n");

    await s.push();
    expect(sync.content("projects/acme/brief.md")).toBe("v2 by the agent\n");
    expect(sync.content("projects/other/readme.md")).toBe("other\n");

    // Discard on the server: the rows go back to the head and the checkout leaves the pull.
    sync.checkouts.splice(0);
    sync.serverWrite("projects/acme/brief.md", "v1\n");
    await s.pull();
    expect(await readFile(acme, "utf8")).toBe("v1\n");
    expect(await modeOf(t, "projects/acme/brief.md")).toBe(0o444);
    expect(await modeOf(t, "projects/acme")).toBe(0o555);

    // The same tool write now fails like in any read-only project folder.
    await play(t, RUN_2, [
      { tool: "write", id: "w3", args: { path: acme, content: "too late\n" } },
    ]);
    await allowNext(t, 2);
    expect(await toolEnd(t, "w3")).toMatchObject({ isError: true });
    expect(await readFile(acme, "utf8")).toBe("v1\n");
  }, 120_000);

  it("ac-2: commit_project and the access line follow run.start.project.access", async () => {
    sync.checkouts.push(CHECKOUT);
    const { t } = await start();
    await play(t, RUN, [{ echoSystemPrompt: true }], { ...PROJECT, access: "write" });
    const write = await systemText(t, 0);
    expect(write).toContain("commit_project");
    expect(write).toContain('You can edit project "Acme"; commit with commit_project');

    // Same Pi, a reader's run: no tool, and the agent can say why.
    await play(t, RUN_2, [{ echoSystemPrompt: true }], { ...PROJECT, access: "read" });
    const read = await systemText(t, 1);
    expect(read).not.toContain("commit with commit_project");
    expect(read).toContain('You can read project "Acme" but not change it');
    expect(read.split("commit_project").length - 1).toBe(0);
    expect(t.server.frames("pi.exited")).toEqual([]);
  }, 120_000);

  it("ac-2: a reader's run cannot call commit_project at all", async () => {
    const { t } = await start();
    await play(t, RUN, [{ tool: "commit_project", id: "c0", args: { message: "sneak" } }], {
      ...PROJECT,
      access: "read",
    });
    const end = await toolEnd(t, "c0");
    expect(end.isError).toBe(true);
    expect(checks(t)).toEqual([]);
    expect(commits(t)).toEqual([]);
  }, 90_000);

  it("ac-2: a refused policy check reaches the model with its reason; nothing is pushed or committed", async () => {
    sync.checkouts.push(CHECKOUT);
    const { t, s } = await start();
    const pushes = () => sync.requests.filter((r) => r === "POST /commit").length;
    const before = pushes();
    await play(t, RUN, [{ tool: "commit_project", id: "c1", args: { message: "Update brief" } }]);
    await until(() => checks(t).length > 0, 30_000);
    const check = checks(t)[0] as CheckFrame;
    expect(check).toMatchObject({ tool: "commit_project", input: { message: "Update brief" } });
    decide(t, check, "deny", "Project commits need an approval rule in this workspace");
    expect(await toolEnd(t, "c1")).toEqual({
      isError: true,
      text: "policy.denied: Project commits need an approval rule in this workspace",
    });
    expect(commits(t)).toEqual([]);
    expect(pushes()).toBe(before);
    expect(s.checkouts.has("acme")).toBe(true);
  }, 90_000);

  it("ac-2: an allowed commit pushes the working copy first, then sends project.commit, and relays each answer", async () => {
    sync.checkouts.push(CHECKOUT);
    const { t } = await start();
    const acme = path.join(t.workspace, "projects/acme/brief.md");
    await play(t, RUN, [
      { tool: "write", id: "w1", args: { path: acme, content: "v2\n" } },
      { tool: "commit_project", id: "c1", args: { message: "Rewrite the brief" } },
      { tool: "commit_project", id: "c2", args: { message: "Again" } },
    ]);
    await allowNext(t, 0);
    await toolEnd(t, "w1");
    const check = await allowNext(t, 1);
    expect(check.tool).toBe("commit_project");
    await until(() => commits(t).length > 0, 30_000);
    // The push came first: the manifest already holds the working copy.
    expect(sync.content("projects/acme/brief.md")).toBe("v2\n");
    const frame = commits(t)[0] as CommitFrame;
    expect(frame).toEqual({
      v: 1,
      type: "project.commit",
      request_id: expect.any(String),
      run_id: RUN,
      thread_id: check.thread_id,
      tool_call_id: "c1",
      tool: "commit_project",
      input: { message: "Rewrite the brief" },
    });
    t.server.send({
      v: 1,
      type: "project.commit_result",
      request_id: frame.request_id,
      ok: true,
      op: "project_commit",
      outcome: { status: "committed", seq: 2 },
    } as never);
    expect(await toolEnd(t, "c1")).toEqual({ isError: false, text: "Committed as #2." });

    await allowNext(t, 2);
    await until(() => commits(t).length > 1, 30_000);
    t.server.send({
      v: 1,
      type: "project.commit_result",
      request_id: (commits(t)[1] as CommitFrame).request_id,
      ok: true,
      op: "project_commit",
      outcome: { status: "commit_conflict", head_seq: 3 },
    } as never);
    const conflict = await toolEnd(t, "c2");
    expect(conflict.isError).toBe(false);
    expect(conflict.text).toMatch(/moved on to #3.*Ask the user to Update/);
  }, 120_000);

  it("ac-2: a server refusal (an auto or scheduled run, D32) is relayed as the tool error", async () => {
    sync.checkouts.push(CHECKOUT);
    const { t } = await start();
    await play(t, RUN, [{ tool: "commit_project", id: "c1", args: { message: "Nightly" } }]);
    await allowNext(t, 0);
    await until(() => commits(t).length > 0, 30_000);
    t.server.send({
      v: 1,
      type: "project.commit_result",
      request_id: (commits(t)[0] as CommitFrame).request_id,
      ok: false,
      error: { code: "not_allowed", message: "agent commits are refused in scheduled runs" },
    } as never);
    expect(await toolEnd(t, "c1")).toEqual({
      isError: true,
      text: "not_allowed: agent commits are refused in scheduled runs",
    });
  }, 90_000);
});
