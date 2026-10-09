import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SandboxToServerFrame } from "@kobe/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeSyncServer } from "./testing/fake-sync-server.js";
import { RUN, startHarness, until, runStart, type Harness } from "./testing/harness.js";
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
 * KOBE-149 against the REAL pinned Pi with the real kobe-policy and kobe-tools, through
 * kobe-sandbox-agent, a fake Kobe server (wire) and a fake workspace-sync server (HTTP): Pi lists
 * `share_file`, kobe-policy decides first, the agent pushes the file and only then sends
 * `file.share`, and the server's `file.share_result` is the tool result.
 */
type PiEventFrame = Extract<SandboxToServerFrame, { type: "pi.event" }>;
type CheckFrame = Extract<SandboxToServerFrame, { type: "policy.check" }>;
type ShareFrame = Extract<SandboxToServerFrame, { type: "file.share" }>;

const FILE_ID = "8e9f0a1b-2c3d-4e4f-9a5b-6c7d8e9f0a1b";

const sync = new FakeSyncServer();
let syncUrl: string;
let h: Harness | undefined;

beforeEach(async () => {
  syncUrl = await sync.start();
});
afterEach(async () => {
  expect(h?.server.violations ?? []).toEqual([]);
  await h?.close();
  h = undefined;
  await sync.stop();
  sync.rows.clear();
  sync.blobs.clear();
  sync.failWith = undefined;
});

interface Options {
  readonly tools?: boolean;
  readonly workspace?: boolean;
}

async function start({ tools = true, workspace = true }: Options = {}): Promise<Harness> {
  h = await startHarness({
    piBin: PI_BIN,
    env: { KOBE_POLICY_EXTENSION: REAL_POLICY_EXTENSION },
    extensions: [FAUX_MODEL_EXTENSION],
    ...(tools ? { toolsExtension: REAL_TOOLS_EXTENSION } : {}),
    ...(workspace
      ? {
          workspace: (dir: string) => {
            const s = new WorkspaceSync({
              root: dir,
              client: new SyncClient({ serverUrl: syncUrl, readToken: async () => sync.token }),
              logger: { debug() {}, info() {}, warn() {} },
              intervalMs: 60_000,
            });
            s.start();
            return s;
          },
        }
      : {}),
  });
  await mkdir(path.join(h.workspace, "out"), { recursive: true });
  await writeFile(path.join(h.workspace, "out", "report.csv"), "a,b\n1,2\n");
  return h;
}

const checks = (t: Harness) => t.server.frames("policy.check") as CheckFrame[];
const shares = (t: Harness) => t.server.frames("file.share") as ShareFrame[];

function allow(t: Harness, check: CheckFrame) {
  t.server.send({
    v: 1,
    type: "policy.result",
    request_id: check.request_id,
    run_id: check.run_id,
    tool_call_id: check.tool_call_id,
    decision: "allow",
    reasons: [{ code: "user_allow_rule", stage: "user_allow", message: "allowed" }],
  } as never);
}

async function toolEnd(t: Harness, toolCallId: string, waitMs = 30_000) {
  const events = () =>
    (t.server.frames("pi.event") as PiEventFrame[]).map((f) => f.event as Record<string, unknown>);
  await until(
    () => events().some((e) => e.type === "tool_execution_end" && e.toolCallId === toolCallId),
    waitMs,
  );
  const end = events().find(
    (e) => e.type === "tool_execution_end" && e.toolCallId === toolCallId,
  ) as { isError: boolean; result: { content: { text: string }[] } };
  return { isError: end.isError, text: end.result.content.map((c) => c.text).join("") };
}

async function share(t: Harness, id: string, args: Record<string, unknown>) {
  const result = await t.server.command(
    runStart(fauxScript([{ tool: "share_file", id, args }])),
    30_000,
  );
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  await until(() => checks(t).length > 0, 30_000);
  allow(t, checks(t)[0] as CheckFrame);
}

describe.skipIf(!PI_AVAILABLE)("share_file in real Pi, through kobe-sandbox-agent", () => {
  it("announces the files capability only with the tools extension and workspace sync", async () => {
    const caps = (t: Harness) =>
      (t.server.frames("hello")[0] as { capabilities?: string[] }).capabilities ?? [];
    expect(caps(await start())).toContain("files");
    await h?.close();
    expect(caps(await start({ workspace: false }))).not.toContain("files");
    await h?.close();
    expect(caps(await start({ tools: false }))).not.toContain("files");
  }, 90_000);

  it("runs kobe-policy first, pushes, then sends file.share and returns the result", async () => {
    const t = await start();
    const args = { path: "out/report.csv", name: "Q3.csv", description: "Q3 numbers" };
    const result = await t.server.command(
      runStart(fauxScript([{ tool: "share_file", id: "s1", args }])),
      30_000,
    );
    expect(result).toMatchObject({ ok: true });
    await until(() => checks(t).length > 0, 30_000);
    expect(checks(t)[0]).toMatchObject({ tool: "share_file", tool_call_id: "s1", input: args });
    // Not allowed yet: nothing pushed, nothing shared.
    await new Promise((r) => setTimeout(r, 300));
    expect(shares(t)).toEqual([]);
    expect(sync.livePaths()).toEqual([]);
    allow(t, checks(t)[0] as CheckFrame);
    await until(() => shares(t).length > 0, 30_000);
    const frame = shares(t)[0] as ShareFrame;
    // The file was pushed (a live row with that rev and hash) before the frame was sent.
    const row = sync.rows.get("out/report.csv");
    expect(row).toBeDefined();
    expect(frame).toEqual({
      v: 1,
      type: "file.share",
      request_id: expect.any(String),
      run_id: RUN,
      thread_id: (checks(t)[0] as CheckFrame).thread_id,
      tool_call_id: "s1",
      tool: "share_file",
      input: args,
      workspace: { path: "out/report.csv", rev: row?.rev, sha256: row?.sha256, size: 8 },
    });
    const record = {
      file_id: FILE_ID,
      name: "Q3.csv",
      mime_type: "text/csv",
      size_bytes: 8,
      scan: "clean",
      created_at: "2026-10-09T10:00:00.000Z",
      sha256: row?.sha256,
    };
    t.server.send({
      v: 1,
      type: "file.share_result",
      request_id: frame.request_id,
      ok: true,
      ...record,
    } as never);
    const end = await toolEnd(t, "s1");
    expect(end.isError).toBe(false);
    expect(JSON.parse(end.text)).toEqual(record);
  }, 90_000);

  it("turns a server error into a tool error", async () => {
    const t = await start();
    await share(t, "e1", { path: "out/report.csv" });
    await until(() => shares(t).length > 0, 30_000);
    t.server.send({
      v: 1,
      type: "file.share_result",
      request_id: (shares(t)[0] as ShareFrame).request_id,
      ok: false,
      error: { code: "not_synced", message: "changed since the push" },
    } as never);
    expect(await toolEnd(t, "e1")).toEqual({
      isError: true,
      text: "not_synced: changed since the push",
    });
  }, 90_000);

  it("returns a clear tool error and sends nothing when the push fails", async () => {
    const t = await start();
    sync.failWith = 500;
    await share(t, "p1", { path: "out/report.csv" });
    const end = await toolEnd(t, "p1");
    expect(end.isError).toBe(true);
    expect(end.text).toMatch(/^not_synced: /);
    expect(shares(t)).toEqual([]);
  }, 90_000);

  it.each([
    ["a symlink to a file outside the workspace", "escape.txt", "invalid_path"],
    ["a path outside the workspace", "/etc/hosts", "invalid_path"],
    ["a traversal (refused by the contract schema)", "out/../../x", "invalid_input"],
    ["a missing file", "out/none.csv", "not_found"],
  ])(
    "refuses %s before pushing anything",
    async (_name, p, code) => {
      const t = await start();
      const outside = path.join(t.dir, "outside.txt");
      await writeFile(outside, "not for sharing");
      await symlink(outside, path.join(t.workspace, "escape.txt"));
      await share(t, "x1", { path: p });
      const end = await toolEnd(t, "x1");
      expect(end).toMatchObject({ isError: true });
      expect(end.text).toMatch(new RegExp(`^${code}: `));
      expect(shares(t)).toEqual([]);
      expect(sync.livePaths()).toEqual([]);
    },
    90_000,
  );

  it("offers no share_file to a Pi whose agent has no workspace sync (old image)", async () => {
    const t = await start({ workspace: false });
    const result = await t.server.command(
      runStart(fauxScript([{ tool: "share_file", id: "n1", args: { path: "out/report.csv" } }])),
      30_000,
    );
    expect(result).toMatchObject({ ok: true });
    const end = await toolEnd(t, "n1");
    expect(end.isError).toBe(true);
    expect(shares(t)).toEqual([]);
  }, 90_000);
});
