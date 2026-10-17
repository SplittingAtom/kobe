import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  startLocalGateway,
  type LocalGateway,
  type LocalGatewayOptions,
} from "@kobe/model-gateway/testing";
import type { SandboxToServerFrame, ThinkingLevel } from "@kobe/protocol";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelTokenSource } from "./models/types.js";
import { RUN, RUN_2, runStart, startHarness, type Harness } from "./testing/harness.js";
import { PI_AVAILABLE, PI_BIN, REAL_POLICY_EXTENSION } from "./testing/real-pi.js";

/**
 * KOBE-260 ac-3 end to end: kobe-sandbox-agent → the REAL pinned Pi 1.0.0 → the REAL model
 * gateway → the fake provider, which reasons (`reasoning_content`, like glm-5.3 on Ollama) unless
 * the request says `reasoning_effort: "none"`. The run's level comes from the server's record
 * (the gateway's `runThinking` seam); whatever Pi sends, the gateway writes that level, clamped.
 */
const PACKAGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REAL_MODELS_EXTENSION =
  process.env.CI === undefined
    ? path.join(PACKAGE, "src/kobe-models/index.ts")
    : path.join(PACKAGE, "dist/kobe-models/index.js");
if (process.env.CI !== undefined && !existsSync(REAL_MODELS_EXTENSION)) {
  throw new Error(`kobe-models is not built: ${REAL_MODELS_EXTENSION} (run pnpm build first)`);
}

const MODEL = {
  alias: "glm",
  gateway_model: "ollama/glm-fake",
  api: "openai-completions",
} as const;
/** Site settings: thinking allowed, default low, at most medium (no team narrowing). */
const SITE: NonNullable<LocalGatewayOptions["thinking"]>[number] = {
  model: MODEL.gateway_model,
  control: "reasoning_effort",
  allowed: true,
  default: "low",
  max: "medium",
  lowest: "off",
  teamMax: null,
};

type PiEvent = Extract<SandboxToServerFrame, { type: "pi.event" }>;

let h: Harness | undefined;
let gateway: LocalGateway | undefined;
afterEach(async () => {
  expect(h?.server.violations ?? []).toEqual([]);
  await h?.close();
  await gateway?.close();
  h = undefined;
  gateway = undefined;
});

const tokens = (token: string): ModelTokenSource => ({
  current: async () => token,
  onChange: () => () => undefined,
});

async function start(levels: ReadonlyMap<string, ThinkingLevel>) {
  gateway = await startLocalGateway({
    enabledModels: [MODEL.gateway_model],
    thinking: [SITE],
    runThinking: (runId) => levels.get(runId),
  });
  h = await startHarness({
    piBin: PI_BIN,
    env: { KOBE_POLICY_EXTENSION: REAL_POLICY_EXTENSION },
    models: {
      gatewayUrl: gateway.url,
      extension: REAL_MODELS_EXTENSION,
      tokens: tokens(gateway.mintToken()),
    },
  });
  return { h, gateway };
}

/** One run with the server's level in run.start; its assistant text and its reasoning. */
async function run(harness: Harness, runId: string, level: ThinkingLevel) {
  const config = { model: MODEL, thinking_level: level };
  const result = await harness.server.command(
    runStart("think?", { run_id: runId, config }),
    60_000,
  );
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  await harness.server.waitFor(
    (f) => f.type === "pi.event" && f.run_id === runId && f.event.type === "agent_settled",
    60_000,
  );
  const updates = (harness.server.frames("pi.event") as PiEvent[])
    .filter((f) => f.run_id === runId && f.event.type === "message_update")
    .map((f) => f.event.assistantMessageEvent as { type: string; delta?: string });
  const of = (type: string) =>
    updates
      .filter((u) => u.type === type)
      .map((u) => u.delta ?? "")
      .join("");
  return { text: of("text_delta"), reasoning: of("thinking_delta") };
}

describe.skipIf(!PI_AVAILABLE)("thinking levels through real Pi and the gateway (KOBE-260)", () => {
  it("thinking off: the provider is told so and no reasoning reaches the run (ac-3)", async () => {
    const { h, gateway } = await start(new Map([[RUN, "off"]]));
    const off = await run(h, RUN, "off");
    expect(off).toEqual({ text: "fake-openai: thought at none", reasoning: "" });
    expect(gateway.seen.at(-1)?.thinking).toMatchObject({ reasoning_effort: "none" });
  }, 90_000);

  it("a level above the site's maximum is clamped on the wire (ac-2)", async () => {
    const { h, gateway } = await start(new Map([[RUN_2, "high"]]));
    const high = await run(h, RUN_2, "high");
    expect(high).toEqual({
      text: "fake-openai: thought at medium",
      reasoning: "fake reasoning at medium",
    });
    expect(gateway.seen.at(-1)?.thinking).toMatchObject({ reasoning_effort: "medium" });
  }, 90_000);
});
