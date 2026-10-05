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
 * KOBE-128 against the REAL pinned Pi 1.0.0 with the real kobe-policy and kobe-tools extensions,
 * through kobe-sandbox-agent and a fake Kobe server (which answers `policy.check` and
 * `artifact.put`). A scripted model makes Pi call the tools without credentials.
 */
type PiEventFrame = Extract<SandboxToServerFrame, { type: "pi.event" }>;
type CheckFrame = Extract<SandboxToServerFrame, { type: "policy.check" }>;
type PutFrame = Extract<SandboxToServerFrame, { type: "artifact.put" }>;

const ARTIFACT = "7d8e9f0a-1b2c-4d3e-8f4a-5b6c7d8e9f0a";
const NOTES = { kind: "markdown", title: "Notes", content: "# Notes\n\nhello" };

let h: Harness | undefined;
afterEach(async () => {
  expect(h?.server.violations ?? []).toEqual([]);
  await h?.close();
  h = undefined;
});

async function start(withTools = true): Promise<Harness> {
  h = await startHarness({
    piBin: PI_BIN,
    env: { KOBE_POLICY_EXTENSION: REAL_POLICY_EXTENSION },
    extensions: [FAUX_MODEL_EXTENSION],
    ...(withTools ? { toolsExtension: REAL_TOOLS_EXTENSION } : {}),
  });
  return h;
}

const checks = (t: Harness) => t.server.frames("policy.check") as CheckFrame[];
const puts = (t: Harness) => t.server.frames("artifact.put") as PutFrame[];

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

async function call(t: Harness, tool: string, id: string, args: Record<string, unknown>) {
  const result = await t.server.command(runStart(fauxScript([{ tool, id, args }])), 30_000);
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
}

describe.skipIf(!PI_AVAILABLE)("kobe-tools in real Pi, through kobe-sandbox-agent", () => {
  it("announces the artifacts capability only with the extension configured", async () => {
    const t = await start();
    expect((t.server.frames("hello")[0] as { capabilities?: string[] }).capabilities).toContain(
      "artifacts",
    );
    await t.close();
    const bare = await start(false);
    expect(
      (bare.server.frames("hello")[0] as { capabilities?: string[] }).capabilities ?? [],
    ).not.toContain("artifacts");
  }, 60_000);

  it("runs kobe-policy first, then sends artifact.put, and returns artifact_id and version", async () => {
    const t = await start();
    await call(t, "create_artifact", "a1", NOTES);
    await until(() => checks(t).length > 0, 30_000);
    expect(checks(t)[0]).toMatchObject({
      tool: "create_artifact",
      tool_call_id: "a1",
      input: NOTES,
    });
    // Nothing reaches the server as an artifact until the policy allowed the call.
    await new Promise((r) => setTimeout(r, 300));
    expect(puts(t)).toEqual([]);
    allow(t, checks(t)[0] as CheckFrame);
    await until(() => puts(t).length > 0, 30_000);
    const put = puts(t)[0] as PutFrame;
    expect(put).toEqual({
      v: 1,
      type: "artifact.put",
      request_id: expect.any(String),
      run_id: RUN,
      thread_id: (checks(t)[0] as CheckFrame).thread_id,
      tool_call_id: "a1",
      tool: "create_artifact",
      input: NOTES,
    });
    t.server.send({
      v: 1,
      type: "artifact.result",
      request_id: put.request_id,
      ok: true,
      artifact_id: ARTIFACT,
      version: 1,
    } as never);
    const end = await toolEnd(t, "a1");
    expect(end.isError).toBe(false);
    expect(JSON.parse(end.text)).toEqual({ artifact_id: ARTIFACT, version: 1 });
  }, 60_000);

  it("registers update_artifact and turns a server error into a tool error", async () => {
    const t = await start();
    await call(t, "update_artifact", "u1", { artifact_id: ARTIFACT, content: "v2" });
    await until(() => checks(t).length > 0, 30_000);
    allow(t, checks(t)[0] as CheckFrame);
    await until(() => puts(t).length > 0, 30_000);
    t.server.send({
      v: 1,
      type: "artifact.result",
      request_id: (puts(t)[0] as PutFrame).request_id,
      ok: false,
      error: { code: "not_found", message: "no such artifact" },
    } as never);
    expect(await toolEnd(t, "u1")).toEqual({ isError: true, text: "not_found: no such artifact" });
  }, 60_000);

  it("refuses a call whose frame would exceed 1 MiB, before anything is sent", async () => {
    const t = await start();
    await call(t, "create_artifact", "big", {
      kind: "html",
      title: "t",
      content: "\u0001".repeat(512 * 1024),
    });
    const end = await toolEnd(t, "big");
    expect(end.isError).toBe(true);
    expect(end.text).toMatch(/too large/);
    expect(puts(t)).toEqual([]);
  }, 60_000);

  it("fails the tool when the connection to the server drops while waiting", async () => {
    const t = await start();
    await call(t, "create_artifact", "d1", NOTES);
    await until(() => checks(t).length > 0, 30_000);
    allow(t, checks(t)[0] as CheckFrame);
    await until(() => puts(t).length > 0, 30_000);
    t.server.terminate();
    const end = await toolEnd(t, "d1");
    expect(end.isError).toBe(true);
    expect(end.text).toMatch(/connection to Kobe server lost/);
  }, 60_000);

  it("offers no artifact tools to a Pi started without the extension (old image)", async () => {
    const t = await start(false);
    await call(t, "create_artifact", "n1", NOTES);
    const end = await toolEnd(t, "n1");
    expect(end.isError).toBe(true);
    expect(puts(t)).toEqual([]);
  }, 60_000);
});
