import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  startLocalGateway,
  type GateDecision,
  type LocalGateway,
} from "@kobe/model-gateway/testing";
import { parseKobeModelError, type PiModelApi, type SandboxToServerFrame } from "@kobe/protocol";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelTokenSource, ModelWiring } from "./models/types.js";
import { RUN, RUN_2, runStart, startHarness, type Harness } from "./testing/harness.js";
import { PI_AVAILABLE, PI_BIN, REAL_POLICY_EXTENSION } from "./testing/real-pi.js";

/**
 * The working path (KOBE-41): a message → kobe-sandbox-agent → the REAL pinned Pi 1.0.0 with
 * kobe-models → the REAL model-gateway shim (session token verified, member's virtual key
 * attached, run attributed) → a fake upstream standing in for Bifrost and the provider, which
 * answers each protocol it is asked in (OpenAI, Anthropic, Gemini). Every Pi also loads the real
 * kobe-policy. See testing/real-pi.ts for how Pi is found.
 */
const PACKAGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REAL_MODELS_EXTENSION =
  process.env.CI === undefined
    ? path.join(PACKAGE, "src/kobe-models/index.ts")
    : path.join(PACKAGE, "dist/kobe-models/index.js");
if (process.env.CI !== undefined && !existsSync(REAL_MODELS_EXTENSION)) {
  throw new Error(`kobe-models is not built: ${REAL_MODELS_EXTENSION} (run pnpm build first)`);
}

const RUN_3 = "4f5a6b7c-8d9e-4fa0-9b2c-3d4e5f607183";
const RUN_4 = "5a6b7c8d-9eaf-4b01-8c3d-4e5f60718294";
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
const GEMINI = {
  alias: "gem",
  gateway_model: "gemini/gemini-fake",
  api: "google-generative-ai" as const,
};
const ENABLED = [OPENAI, ANTHROPIC, GEMINI].map((m) => m.gateway_model);

type PiEvent = Extract<SandboxToServerFrame, { type: "pi.event" }>;

function tokenSource(initial: string): ModelTokenSource & { rotate(token: string): void } {
  let current = initial;
  const listeners = new Set<(token: string) => void>();
  return {
    current: async () => current,
    onChange(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    rotate(token) {
      current = token;
      for (const l of listeners) l(token);
    },
  };
}

let h: Harness | undefined;
let gateway: LocalGateway | undefined;
afterEach(async () => {
  expect(h?.server.violations ?? []).toEqual([]);
  await h?.close();
  await gateway?.close();
  h = undefined;
  gateway = undefined;
});

const leased = new Set<string>([RUN, RUN_2, RUN_3, RUN_4]);
let refusals: GateDecision[] = [];

async function start() {
  refusals = [];
  gateway = await startLocalGateway({
    enabledModels: ENABLED,
    isRunLeased: (runId) => leased.has(runId),
    gate: { admit: async () => refusals.shift() ?? { ok: true } },
  });
  const tokens = tokenSource(gateway.mintToken());
  const models: ModelWiring = {
    gatewayUrl: gateway.url,
    extension: REAL_MODELS_EXTENSION,
    tokens,
  };
  h = await startHarness({
    piBin: PI_BIN,
    env: { KOBE_POLICY_EXTENSION: REAL_POLICY_EXTENSION },
    models,
  });
  return { h, gateway, tokens };
}

const settled = (runId: string) => (f: SandboxToServerFrame) =>
  f.type === "pi.event" && f.run_id === runId && f.event.type === "agent_settled";

function runEvents(harness: Harness, runId: string): PiEvent[] {
  return (harness.server.frames("pi.event") as PiEvent[]).filter((f) => f.run_id === runId);
}

function textOf(events: PiEvent[]): string {
  return events
    .flatMap((f) =>
      f.event.type === "message_update"
        ? [(f.event.assistantMessageEvent as { delta?: string }).delta ?? ""]
        : [],
    )
    .join("");
}

function lastAssistantError(events: PiEvent[]): string | undefined {
  const ends = events.filter(
    (f) =>
      f.event.type === "message_end" && (f.event.message as { role: string }).role === "assistant",
  );
  const last = ends.at(-1)?.event.message as { errorMessage?: string } | undefined;
  return last?.errorMessage;
}

type RunModelConfig = { alias: string; gateway_model: string; api: PiModelApi };

async function run(harness: Harness, runId: string, message: string, model: RunModelConfig) {
  const result = await harness.server.command(
    runStart(message, { run_id: runId, config: { model } }),
    60_000,
  );
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  await harness.server.waitFor(settled(runId), 60_000);
  return runEvents(harness, runId);
}

describe.skipIf(!PI_AVAILABLE)("kobe-models in real Pi, through the real model gateway", () => {
  it("streams a model's answer: token as the API key, run attributed, provider key never in the sandbox", async () => {
    const { h, gateway } = await start();
    const events = await run(h, RUN, "hello-pi", OPENAI);
    expect(textOf(events)).toBe("fake-openai: hello-pi");
    expect(lastAssistantError(events)).toBeUndefined();
    // The shim verified the token, attributed the call to the run and attached the virtual key.
    expect(gateway.calls.map((c) => [c.route, c.model, c.runId, c.status])).toEqual([
      ["openai", "openai/gpt-fake", RUN, 200],
    ]);
    const upstream = gateway.seen.at(-1);
    expect(upstream?.credentials).toEqual({ "x-bf-vk": gateway.virtualKey });
    expect(gateway.seen.every((s) => Object.keys(s.credentials).join() === "x-bf-vk")).toBe(true);
  }, 90_000);

  it("switches models between runs without restarting Pi: Anthropic native and Gemini too", async () => {
    const { h, gateway } = await start();
    expect(textOf(await run(h, RUN, "one", OPENAI))).toBe("fake-openai: one");
    expect(textOf(await run(h, RUN_2, "two", ANTHROPIC))).toBe("fake-anthropic: two");
    expect(textOf(await run(h, RUN_3, "three", GEMINI))).toBe("fake-gemini: three");
    expect(gateway.calls.map((c) => [c.route, c.model, c.runId])).toEqual([
      ["openai", "openai/gpt-fake", RUN],
      ["anthropic", "anthropic/claude-fake", RUN_2],
      ["gemini", "gemini/gemini-fake", RUN_3],
    ]);
    // One Pi for all three: the agent reported no exit and no second kobe-policy handshake.
    expect(h.server.frames("pi.exited")).toEqual([]);
  }, 120_000);

  it("fails a run on a model the team has not enabled with model_not_enabled (403 from the shim)", async () => {
    const { h, gateway } = await start();
    const events = await run(h, RUN, "nope", { ...OPENAI, gateway_model: "openai/not-enabled" });
    expect(parseKobeModelError(lastAssistantError(events))).toBe("model_not_enabled");
    expect(textOf(events)).toBe("");
    expect(gateway.calls.map((c) => c.status)).toEqual([403]);
    expect(gateway.seen).toEqual([]);
  }, 90_000);

  it("uses a rotated token on the next request: an expired one is refused, a fresh one works", async () => {
    const { h, gateway, tokens } = await start();
    expect(textOf(await run(h, RUN, "a", OPENAI))).toBe("fake-openai: a");
    tokens.rotate(gateway.mintToken({ expiresInSeconds: -5 }));
    const refused = await run(h, RUN_2, "b", OPENAI);
    expect(parseKobeModelError(lastAssistantError(refused))).toBe("model_session_revoked");
    tokens.rotate(gateway.mintToken());
    expect(textOf(await run(h, RUN_3, "c", OPENAI))).toBe("fake-openai: c");
    expect(h.server.frames("pi.exited")).toEqual([]);
  }, 120_000);

  it("waits Retry-After on a 503 from the gateway and then answers (no error reaches the run)", async () => {
    const { h, gateway } = await start();
    refusals = [
      {
        ok: false,
        status: 503,
        code: "model_access_pending",
        message: "setting up",
        retryAfterSeconds: 1,
      },
    ];
    const t0 = Date.now();
    const events = await run(h, RUN, "patient", OPENAI);
    expect(textOf(events)).toBe("fake-openai: patient");
    expect(lastAssistantError(events)).toBeUndefined();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1000);
    expect(gateway.calls.map((c) => c.status)).toEqual([503, 200]);
    // The gateway's refusal never became an assistant error in Pi's stream.
    expect(
      events.filter(
        (f) =>
          f.event.type === "message_end" &&
          (f.event.message as { stopReason?: string }).stopReason === "error",
      ),
    ).toEqual([]);
  }, 90_000);
});
