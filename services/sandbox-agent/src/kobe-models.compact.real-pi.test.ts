import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startLocalGateway, type LocalGateway } from "@kobe/model-gateway/testing";
import type { SandboxToServerFrame } from "@kobe/protocol";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelWiring } from "./models/types.js";
import { RUN, RUN_2, THREAD, runStart, startHarness, type Harness } from "./testing/harness.js";
import { startTap, type Listener } from "./testing/real-pi-rpc.js";
import { PI_AVAILABLE, PI_BIN, REAL_POLICY_EXTENSION } from "./testing/real-pi.js";

/**
 * KOBE-213 with the REAL Pi 1.0.0, kobe-models and kobe-policy through the real model-gateway
 * shim: `thread.compact` becomes Pi's `compact`, whose summary call goes to the compaction run's
 * model carrying that run's id and token (fetched on `session_before_compact`, since compact
 * fires no `input`), and the focus reaches Pi's summary prompt.
 */
const PACKAGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODELS_EXTENSION =
  process.env.CI === undefined
    ? path.join(PACKAGE, "src/kobe-models/index.ts")
    : path.join(PACKAGE, "dist/kobe-models/index.js");
if (process.env.CI !== undefined && !existsSync(MODELS_EXTENSION)) {
  throw new Error(`kobe-models is not built: ${MODELS_EXTENSION} (run pnpm build first)`);
}

const OPENAI = {
  alias: "fast",
  gateway_model: "openai/gpt-fake",
  api: "openai-completions" as const,
};
const ANTHROPIC = {
  alias: "smart",
  gateway_model: "anthropic/claude-fake",
  api: "anthropic-messages" as const,
};
const RUN_TOKEN = { token: "krt1.first-run.mac", expires_at: "2099-01-01T00:00:00Z" };
const COMPACT_TOKEN = { token: "krt1.compaction-run.mac", expires_at: "2099-01-01T00:00:00Z" };
const FOCUS = "keep the deployment decisions";

let h: Harness | undefined;
let gateway: LocalGateway | undefined;
let tap: Listener | undefined;
afterEach(async () => {
  expect(h?.server.violations ?? []).toEqual([]);
  await h?.close();
  await tap?.close();
  await gateway?.close();
  h = tap = gateway = undefined;
});

type Result = Extract<SandboxToServerFrame, { type: "thread.compact_result" }>;

describe.skipIf(!PI_AVAILABLE)("thread.compact in real Pi (KOBE-213)", () => {
  it("summarizes with the compaction run's model, id and token, and the focus", async () => {
    gateway = await startLocalGateway({
      enabledModels: [OPENAI, ANTHROPIC].map((m) => m.gateway_model),
      isRunLeased: () => true,
    });
    tap = await startTap(gateway.url);
    const session = gateway.mintToken();
    const models: ModelWiring = {
      gatewayUrl: tap.url,
      extension: MODELS_EXTENSION,
      tokens: { current: async () => session, onChange: () => () => undefined },
    };
    h = await startHarness({
      piBin: PI_BIN,
      env: { KOBE_POLICY_EXTENSION: REAL_POLICY_EXTENSION },
      models,
    });
    const server = h.server;
    // A short turn, one larger than Pi's keepRecentTokens (20k), a short one: Pi keeps the end of
    // the big turn and summarizes the first turn with the focus.
    for (const [runId, message] of [
      [RUN, "first turn"],
      ["6b7c8d9e-af01-4c12-8d3e-5f6071829304", `big: ${"lorem ipsum dolor ".repeat(6_000)}`],
      ["7c8d9eaf-0112-4d23-8e4f-60718293a415", "short"],
    ] as const) {
      const started = await server.command(
        runStart(message, { run_id: runId, config: { model: OPENAI }, run_token: RUN_TOKEN }),
        60_000,
      );
      expect(started, JSON.stringify(started)).toMatchObject({ ok: true });
      await server.waitFor(
        (f) => f.type === "pi.event" && f.run_id === runId && f.event.type === "agent_settled",
        60_000,
      );
    }
    const before = (tap as Listener).requests.length;
    server.send({
      v: 1,
      type: "thread.compact",
      command_id: "compact-1",
      thread_id: THREAD,
      run_id: RUN_2,
      focus: FOCUS,
      // Another model than the conversation's: Pi switches to it before summarizing.
      model: ANTHROPIC,
      run_token: COMPACT_TOKEN,
    } as never);
    const result = await server.waitFor(
      (f): f is Result => f.type === "thread.compact_result" && f.command_id === "compact-1",
      120_000,
    );
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, thread_id: THREAD });
    expect(result.ok && result.summary).toContain("fake-anthropic: ");
    expect(result.ok && result.summary).toContain(FOCUS);
    const calls = (tap as Listener).requests.slice(before);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.headers["x-kobe-run-id"]).toBe(RUN_2);
      expect(call.headers["x-kobe-run-token"]).toBe(COMPACT_TOKEN.token);
    }
    expect(gateway.calls.at(-1)).toMatchObject({ model: ANTHROPIC.gateway_model, runId: RUN_2 });
  }, 180_000);
});
