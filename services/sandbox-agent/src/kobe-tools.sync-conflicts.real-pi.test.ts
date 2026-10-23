import { readFile } from "node:fs/promises";
import path from "node:path";
import type { SandboxToServerFrame } from "@kobe/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { CONFLICTS_HEADER } from "./memory/conflict-context.js";
import type { WorkspaceHooks } from "./agent.js";
import type { ConflictListener } from "./workspace/sync.js";
import {
  RUN,
  RUN_2,
  THREAD,
  runStart,
  startHarness,
  until,
  type Harness,
} from "./testing/harness.js";
import {
  FAUX_MODEL_EXTENSION,
  PI_AVAILABLE,
  PI_BIN,
  REAL_POLICY_EXTENSION,
  REAL_TOOLS_EXTENSION,
  fauxScript,
} from "./testing/real-pi.js";

/**
 * KOBE-492 (ac-1, ac-3) against the REAL pinned Pi 1.0.0 with the real kobe-tools, through
 * kobe-sandbox-agent: a conflict copy the sync makes goes to the server as `workspace.conflict`;
 * conflicts given at run start reach that run's system prompt; a `workspace.conflict_note` during
 * a run reaches the very next model call of that run (as a hidden custom message, which Pi sends
 * in user role) and is never stored in Pi's session.
 */
type PiEventFrame = Extract<SandboxToServerFrame, { type: "pi.event" }>;
type CheckFrame = Extract<SandboxToServerFrame, { type: "policy.check" }>;

const conflict = {
  path: "notes.md",
  conflict_path: "notes.conflict-20261023T120000Z.md",
  member_sha256: "a".repeat(64),
  agent_sha256: "b".repeat(64),
};
const NEEDLES = [CONFLICTS_HEADER, "notes.conflict-20261023T120000Z.md"];
const b64 = (s: string) => Buffer.from(s).toString("base64");

let h: Harness | undefined;
afterEach(async () => {
  expect(h?.server.violations ?? []).toEqual([]);
  await h?.close();
  h = undefined;
});

function fakeWorkspace(): { hooks: WorkspaceHooks; fire: ConflictListener } {
  let listener: ConflictListener | undefined;
  return {
    hooks: {
      beforeRun: () => Promise.resolve(),
      runEnded: () => undefined,
      flush: () => Promise.resolve(),
      onConflict: (l) => {
        listener = l;
      },
    },
    fire: (r) => listener?.(r),
  };
}

function countsOf(t: Harness, runId: string): number[] | undefined {
  for (const f of t.server.frames("pi.event") as PiEventFrame[]) {
    const event = f.event as { type?: string; message?: { role?: string; content?: unknown } };
    if (f.run_id !== runId || event.type !== "message_end") continue;
    if (event.message?.role !== "assistant" || !Array.isArray(event.message.content)) continue;
    const text = event.message.content.map((b: { text?: string }) => b.text ?? "").join("");
    if (text.startsWith("COUNTS:")) return JSON.parse(text.slice("COUNTS:".length)) as number[];
  }
  return undefined;
}

const settled = (t: Harness, runId: string): boolean =>
  (t.server.frames("pi.event") as PiEventFrame[]).some(
    (f) => f.run_id === runId && (f.event as { type?: string }).type === "agent_settled",
  );

describe.skipIf(!PI_AVAILABLE)("sync conflicts in real Pi (KOBE-492)", () => {
  it("reports conflicts, tells a run at its start and mid-run, never stores the note", async () => {
    const ws = fakeWorkspace();
    h = await startHarness({
      piBin: PI_BIN,
      env: { KOBE_POLICY_EXTENSION: REAL_POLICY_EXTENSION },
      extensions: [FAUX_MODEL_EXTENSION],
      toolsExtension: REAL_TOOLS_EXTENSION,
      workspace: () => ws.hooks,
    });
    const t = h;
    const caps = (t.server.frames("hello")[0] as { capabilities?: string[] }).capabilities ?? [];
    expect(caps).toContain("sync_conflicts");

    // The sync's report goes out as a bounded frame: names and hashes only.
    ws.fire({ ...conflict, at: new Date("2026-10-23T12:00:00Z") });
    await until(() => t.server.frames("workspace.conflict").length === 1);
    expect(t.server.frames("workspace.conflict")[0]).toEqual({
      v: 1,
      type: "workspace.conflict",
      ...conflict,
      at: "2026-10-23T12:00:00.000Z",
    });

    // Run 1 starts with the conflict: in its system prompt.
    const first = await t.server.command(
      runStart(fauxScript([{ countInSystem: NEEDLES.map(b64) }]), {
        run_id: RUN,
        sync_conflicts: [conflict],
      }),
      30_000,
    );
    expect(first, JSON.stringify(first)).toMatchObject({ ok: true });
    await until(() => settled(t, RUN), 30_000);
    expect(countsOf(t, RUN)).toEqual([1, 1]);

    // Run 2: the note arrives while a tool call waits for its decision; the next call sees it.
    const second = await t.server.command(
      runStart(
        fauxScript([
          { tool: "bash", id: "c1", args: { command: "true" } },
          { countInMessages: NEEDLES.map(b64) },
        ]),
        { run_id: RUN_2 },
      ),
      30_000,
    );
    expect(second, JSON.stringify(second)).toMatchObject({ ok: true });
    await until(() => t.server.frames("policy.check").length > 0, 30_000);
    const check = t.server.frames("policy.check")[0] as CheckFrame;
    t.server.send({
      v: 1,
      type: "workspace.conflict_note",
      run_id: RUN_2,
      thread_id: THREAD,
      conflicts: [conflict],
    });
    // The note is in the run's memory file before the call is allowed to finish.
    await until(async () => {
      const files = await memoryFiles(t);
      return files.some((f) => f.includes(CONFLICTS_HEADER));
    }, 10_000);
    t.server.send({
      v: 1,
      type: "policy.result",
      request_id: check.request_id,
      run_id: check.run_id,
      tool_call_id: check.tool_call_id,
      decision: "allow",
      reasons: [{ code: "user_allow_rule", stage: "user_allow", message: "allowed" }],
    } as never);
    await until(() => settled(t, RUN_2), 30_000);
    expect(countsOf(t, RUN_2)).toEqual([1, 1]);

    // Never in Pi's session, and never in any frame the server got (except the report itself).
    const session = await readFile(path.join(t.sessions, `${THREAD}.jsonl`), "utf8");
    expect(session).not.toContain(CONFLICTS_HEADER);
    const frames = t.server.received
      .map((r) => r.frame)
      .filter((f) => (f as { type: string }).type !== "workspace.conflict");
    expect(JSON.stringify(frames)).not.toContain(CONFLICTS_HEADER);
  }, 120_000);
});

async function memoryFiles(t: Harness): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const root = path.join(t.dir, "pi-runtime");
  const dirs = await readdir(root).catch(() => [] as string[]);
  const out: string[] = [];
  for (const d of dirs) {
    const text = await readFile(path.join(root, d, "memory-context.json"), "utf8").catch(() => "");
    if (text !== "") out.push(text);
  }
  return out;
}
