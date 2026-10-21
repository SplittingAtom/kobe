import type { SandboxToServerFrame } from "@kobe/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { RUN, startHarness, until, runStart, type Harness } from "./testing/harness.js";
import {
  FAUX_MODEL_EXTENSION,
  PI_AVAILABLE,
  PI_BIN,
  REAL_POLICY_EXTENSION,
  REAL_TOOLS_EXTENSION,
  fauxScript,
} from "./testing/real-pi.js";

/**
 * KOBE-462 against the REAL pinned Pi with the real kobe-policy and kobe-tools, through
 * kobe-sandbox-agent and a fake Kobe server: Pi lists `propose_file_edit`, kobe-policy decides
 * first, the agent sends `file.edit_propose` with the call's input (nothing pushed or written),
 * and the server's answer is the tool result.
 */
type CheckFrame = Extract<SandboxToServerFrame, { type: "policy.check" }>;
type ProposeFrame = Extract<SandboxToServerFrame, { type: "file.edit_propose" }>;
type PiEventFrame = Extract<SandboxToServerFrame, { type: "pi.event" }>;

let h: Harness | undefined;

afterEach(async () => {
  try {
    expect(h?.server.violations ?? []).toEqual([]);
    await h?.close();
  } finally {
    h = undefined;
  }
});

async function start(): Promise<Harness> {
  h = await startHarness({
    piBin: PI_BIN,
    env: { KOBE_POLICY_EXTENSION: REAL_POLICY_EXTENSION },
    extensions: [FAUX_MODEL_EXTENSION],
    toolsExtension: REAL_TOOLS_EXTENSION,
  });
  return h;
}

const checks = (t: Harness) => t.server.frames("policy.check") as CheckFrame[];
const proposals = (t: Harness) => t.server.frames("file.edit_propose") as ProposeFrame[];

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

describe.skipIf(!PI_AVAILABLE)("propose_file_edit in real Pi, through kobe-sandbox-agent", () => {
  it("announces file_edits, runs kobe-policy first, then sends file.edit_propose", async () => {
    const t = await start();
    const hello = t.server.frames("hello")[0] as { capabilities?: string[] };
    expect(hello.capabilities).toContain("file_edits");
    const args = { path: "/workspace/notes.md", content: "# Notes\n", summary: "Tidy" };
    const result = await t.server.command(
      runStart(fauxScript([{ tool: "propose_file_edit", id: "f1", args }])),
      30_000,
    );
    expect(result).toMatchObject({ ok: true });
    await until(() => checks(t).length > 0, 30_000);
    const check = checks(t)[0] as CheckFrame;
    expect(check).toMatchObject({ tool: "propose_file_edit", tool_call_id: "f1", input: args });
    await new Promise((r) => setTimeout(r, 300));
    expect(proposals(t)).toEqual([]);
    t.server.send({
      v: 1,
      type: "policy.result",
      request_id: check.request_id,
      run_id: check.run_id,
      tool_call_id: check.tool_call_id,
      decision: "allow",
      reasons: [{ code: "risk_read", stage: "risk_class", message: "ok" }],
    } as never);
    await until(() => proposals(t).length > 0, 30_000);
    const frame = proposals(t)[0] as ProposeFrame;
    expect(frame).toMatchObject({ tool: "propose_file_edit", tool_call_id: "f1", input: args });
    expect(frame.run_id).toBe(RUN);
    t.server.send({
      v: 1,
      type: "file.edit_propose_result",
      request_id: frame.request_id,
      ok: true,
      op: "file_edit_propose",
      status: "awaiting_user",
      path: "notes.md",
      base_sha256: "e".repeat(64),
    } as never);
    const end = await toolEnd(t, "f1");
    expect(end.isError).toBe(false);
    expect(JSON.parse(end.text)).toMatchObject({ status: "awaiting_user", path: "notes.md" });
  }, 90_000);
});
