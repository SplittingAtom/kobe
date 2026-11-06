import { afterEach, describe, expect, it } from "vitest";
import type { SandboxToServerFrame } from "@kobe/protocol";
import type { ModelWiring } from "./models/types.js";
import { RUN_2, THREAD, runStart, startHarness, type Harness } from "./testing/harness.js";

/**
 * `thread.branch_summary` (KOBE-548) with the scripted Pi: the capability, and the refusals that
 * never reach Pi. The command itself runs in real Pi (kobe-models.branch-summary.real-pi.test.ts).
 */
const TOKEN = "model-token-one-".padEnd(40, "1");
const MODEL = {
  alias: "fast",
  gateway_model: "openai/gpt-fake",
  api: "openai-completions" as const,
};
const GRANT = { token: "krt1.summary-run-token.mac", expires_at: "2099-01-01T00:00:00Z" };

type Result = Extract<SandboxToServerFrame, { type: "thread.branch_summary_result" }>;

const models: ModelWiring = {
  gatewayUrl: "http://model-gateway.kobe.internal:80",
  extension: "/opt/kobe/pi-extensions/kobe-models/index.js",
  tokens: { current: async () => TOKEN, onChange: () => () => undefined },
};

let h: Harness;
afterEach(async () => {
  expect(h.server.violations).toEqual([]);
  await h.close();
});

let next = 0;
async function summarise(): Promise<Result> {
  const frame = {
    v: 1,
    type: "thread.branch_summary",
    command_id: `bs${++next}`,
    thread_id: THREAD,
    run_id: RUN_2,
    from_leaf_entry_id: "leaf0001",
    to_entry_id: "node0001",
    model: MODEL,
    run_token: GRANT,
  };
  h.server.send(frame as never);
  return h.server.waitFor(
    (f): f is Result =>
      f.type === "thread.branch_summary_result" && f.command_id === frame.command_id,
  );
}

describe("thread.branch_summary (KOBE-548)", () => {
  it("is announced only with model wiring; without it the frame is refused", async () => {
    h = await startHarness({ models });
    const hello = await h.server.waitFor((f) => f.type === "hello");
    expect(hello.type === "hello" && hello.capabilities).toContain("thread_branch_summary");
    await h.close();
    h = await startHarness();
    const bare = await h.server.waitFor((f) => f.type === "hello");
    expect(bare.type === "hello" && (bare.capabilities ?? [])).not.toContain(
      "thread_branch_summary",
    );
    expect(await summarise()).toMatchObject({
      ok: false,
      thread_id: THREAD,
      error: { code: "model_not_configured" },
    });
  });

  it("refuses thread_busy while a run is active, with a fixed message", async () => {
    h = await startHarness({ models });
    expect(await h.server.command(runStart("hang", { config: { model: MODEL } }))).toMatchObject({
      ok: true,
    });
    expect(await summarise()).toEqual({
      v: 1,
      type: "thread.branch_summary_result",
      command_id: `bs${next}`,
      thread_id: THREAD,
      ok: false,
      error: { code: "thread_busy", message: "the thread is busy" },
    });
  });
});
