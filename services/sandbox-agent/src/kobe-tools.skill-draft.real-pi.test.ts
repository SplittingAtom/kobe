import { mkdir, writeFile } from "node:fs/promises";
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
 * KOBE-442 against the REAL pinned Pi with the real kobe-policy and kobe-tools, through
 * kobe-sandbox-agent, a fake Kobe server and a fake workspace-sync server: Pi lists
 * `save_skill_draft`, kobe-policy decides first, the agent pushes every file of the folder and
 * only then sends `skill.draft_save`, and the server's answer is the tool result.
 */
type CheckFrame = Extract<SandboxToServerFrame, { type: "policy.check" }>;
type SaveFrame = Extract<SandboxToServerFrame, { type: "skill.draft_save" }>;
type PiEventFrame = Extract<SandboxToServerFrame, { type: "pi.event" }>;

const DRAFT = "8e9f0a1b-2c3d-4e4f-9a5b-6c7d8e9f0a1b";
const sync = new FakeSyncServer();
let syncUrl: string;
let h: Harness | undefined;

beforeEach(async () => {
  syncUrl = await sync.start();
});
afterEach(async () => {
  try {
    expect(h?.server.violations ?? []).toEqual([]);
    await h?.close();
  } finally {
    h = undefined;
    await sync.stop();
    sync.rows.clear();
    sync.blobs.clear();
  }
});

async function start(workspace = true): Promise<Harness> {
  h = await startHarness({
    piBin: PI_BIN,
    env: { KOBE_POLICY_EXTENSION: REAL_POLICY_EXTENSION },
    extensions: [FAUX_MODEL_EXTENSION],
    toolsExtension: REAL_TOOLS_EXTENSION,
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
  const skill = path.join(h.workspace, "skills", "close-helper");
  await mkdir(path.join(skill, "evals"), { recursive: true });
  await writeFile(path.join(skill, "SKILL.md"), "---\nname: close-helper\n---\n# Close\n");
  await writeFile(path.join(skill, "evals", "cases.yaml"), "cases: []\n");
  return h;
}

const checks = (t: Harness) => t.server.frames("policy.check") as CheckFrame[];
const saves = (t: Harness) => t.server.frames("skill.draft_save") as SaveFrame[];

async function toolEnd(t: Harness, toolCallId: string) {
  const events = () =>
    (t.server.frames("pi.event") as PiEventFrame[]).map((f) => f.event as Record<string, unknown>);
  await until(
    () => events().some((e) => e.type === "tool_execution_end" && e.toolCallId === toolCallId),
    30_000,
  );
  const end = events().find(
    (e) => e.type === "tool_execution_end" && e.toolCallId === toolCallId,
  ) as { isError: boolean; result: { content: { text: string }[] } };
  return { isError: end.isError, text: end.result.content.map((c) => c.text).join("") };
}

describe.skipIf(!PI_AVAILABLE)("save_skill_draft in real Pi, through kobe-sandbox-agent", () => {
  it("announces skill_drafts only with workspace sync", async () => {
    const caps = (t: Harness) =>
      (t.server.frames("hello")[0] as { capabilities?: string[] }).capabilities ?? [];
    expect(caps(await start())).toContain("skill_drafts");
    await h?.close();
    expect(caps(await start(false))).not.toContain("skill_drafts");
  }, 90_000);

  it("runs kobe-policy first, pushes the folder, then sends skill.draft_save", async () => {
    const t = await start();
    const args = { folder: "close-helper" };
    const result = await t.server.command(
      runStart(fauxScript([{ tool: "save_skill_draft", id: "k1", args }])),
      30_000,
    );
    expect(result).toMatchObject({ ok: true });
    await until(() => checks(t).length > 0, 30_000);
    const check = checks(t)[0] as CheckFrame;
    expect(check).toMatchObject({ tool: "save_skill_draft", tool_call_id: "k1", input: args });
    await new Promise((r) => setTimeout(r, 300));
    expect(saves(t)).toEqual([]);
    expect(sync.livePaths()).toEqual([]);
    t.server.send({
      v: 1,
      type: "policy.result",
      request_id: check.request_id,
      run_id: check.run_id,
      tool_call_id: check.tool_call_id,
      decision: "allow",
      reasons: [{ code: "risk_write", stage: "risk_class", message: "ok" }],
    } as never);
    await until(() => saves(t).length > 0, 30_000);
    const frame = saves(t)[0] as SaveFrame;
    expect(frame.files.map((f) => f.path)).toEqual([
      "skills/close-helper/SKILL.md",
      "skills/close-helper/evals/cases.yaml",
    ]);
    for (const f of frame.files) expect(sync.rows.get(f.path)?.rev).toBe(f.rev);
    t.server.send({
      v: 1,
      type: "skill.draft_save_result",
      request_id: frame.request_id,
      ok: true,
      op: "skill_draft_save",
      draft_id: DRAFT,
      name: "close-helper",
      created: true,
      rev: 1,
      file_count: 2,
    } as never);
    const end = await toolEnd(t, "k1");
    expect(end.isError).toBe(false);
    expect(JSON.parse(end.text)).toMatchObject({ draft_id: DRAFT, created: true });
    expect(RUN).toBe(frame.run_id);
  }, 90_000);
});
