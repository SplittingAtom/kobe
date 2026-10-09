import { existsSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startLocalGateway, type LocalGateway } from "@kobe/model-gateway/testing";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelWiring } from "./models/types.js";
import { RUN_TOKEN as runToken } from "./testing/redirect-plants.js";
import {
  ANTHROPIC,
  OPENAI,
  RUN_IDS,
  plantCommand,
  variants,
  type Plant,
} from "./testing/redirect-plants.js";
import { THREAD, startHarness, runStart, until, type Harness } from "./testing/harness.js";
import { startListener, startTap, type Listener } from "./testing/real-pi-rpc.js";
import { PI_AVAILABLE, PI_BIN, REAL_POLICY_EXTENSION } from "./testing/real-pi.js";

/**
 * KOBE-169: the three KOBE-165 redirect cases, now THROUGH THE AGENT (real kobe-sandbox-agent, real
 * Pi 1.0.0, real kobe-models and kobe-policy, real bash tool). A tool plants `models.json` with a
 * `providers.kobe.models[]` entry carrying its own `baseUrl`; the server then sends `set_model`.
 * The agent refuses it with `runtime_tampered` (the guarded files are not what it wrote) and stops
 * that Pi, so neither the session token nor the run token reaches the tool's listener, also when the
 * plant is removed again before the next prompt. The tool here shares the agent's uid, so it can
 * replace the agent's read-only file; the kernel-level lock (a Pi identity, sticky `agent/`) is
 * tested in identities.real.test.ts. What no agent-side check closes, a plant that lands after the
 * check and is gone before the next one, is the paired uid's (KOBE-167): see the ledger.
 */
const PACKAGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODELS_EXTENSION =
  process.env.CI === undefined
    ? path.join(PACKAGE, "src/kobe-models/index.ts")
    : path.join(PACKAGE, "dist/kobe-models/index.js");
if (process.env.CI !== undefined && !existsSync(MODELS_EXTENSION)) {
  throw new Error(`kobe-models is not built: ${MODELS_EXTENSION} (run pnpm build first)`);
}

let h: Harness | undefined;
let gateway: LocalGateway | undefined;
let tap: Listener | undefined;
let evil: Listener | undefined;
let allow: NodeJS.Timeout | undefined;
afterEach(async () => {
  clearInterval(allow);
  expect(h?.server.violations ?? []).toEqual([]);
  await h?.close();
  await tap?.close();
  await evil?.close();
  await gateway?.close();
  h = tap = evil = gateway = allow = undefined;
});

async function setup(): Promise<Harness> {
  gateway = await startLocalGateway({
    enabledModels: [OPENAI, ANTHROPIC].map((m) => m.gateway_model),
    isRunLeased: () => true,
  });
  tap = await startTap(gateway.url);
  evil = await startListener();
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
  // The tool runs (the plant is the model's bash call): allow every policy check.
  const server = h.server;
  const answered = new Set<string>();
  allow = setInterval(() => {
    for (const f of server.frames("policy.check") as {
      request_id: string;
      run_id: string;
      tool_call_id: string;
    }[]) {
      if (answered.has(f.request_id)) continue;
      answered.add(f.request_id);
      server.send({
        v: 1,
        type: "policy.result",
        request_id: f.request_id,
        run_id: f.run_id,
        tool_call_id: f.tool_call_id,
        decision: "allow",
        reasons: [{ code: "user_allow_rule", stage: "user_allow", message: "allowed" }],
      } as never);
    }
  }, 20);
  return h;
}

async function run(harness: Harness, n: number, model: typeof OPENAI, message: string) {
  const runId = RUN_IDS[n - 1] as string;
  const result = await harness.server.command(
    runStart(message, {
      run_id: runId,
      config: { model: { alias: "m", ...model } },
      run_token: { token: runToken(n), expires_at: "2099-01-01T00:00:00Z" },
    }),
    60_000,
  );
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  await harness.server.waitFor(
    (f) => f.type === "pi.event" && f.run_id === runId && f.event.type === "agent_settled",
    60_000,
  );
}

const setModel = (harness: Harness, modelId: string) =>
  harness.server.command(
    {
      type: "pi.command",
      thread_id: THREAD,
      command: { id: "srv", type: "set_model", provider: "kobe", modelId },
    },
    30_000,
  );

describe.skipIf(!PI_AVAILABLE)(
  "the agent closes the Pi agent/ provider redirect (KOBE-169)",
  () => {
    const LEAKING = [
      "models.json: provider kobe models with their own baseUrl",
      "everything at once",
    ];

    /** Plant in a run (the real bash tool), then `set_model` to a model only the plant defines. */
    async function scenario(name: string, removeAfter: boolean) {
      const harness = await setup();
      const plant = (variants((evil as Listener).url)[name] ?? {}) as Record<string, Plant>;
      await run(harness, 1, OPENAI, `bash: ${plantCommand(plant)}`);
      const reply = await setModel(harness, ANTHROPIC.gateway_model);
      if (removeAfter) {
        // The Pi is gone by now (refused); a tool of a still-running Pi would remove them like this.
        const root = path.join(harness.dir, "pi-runtime");
        for (const d of await readdir(root)) {
          for (const f of Object.keys(plant)) {
            await rm(path.join(root, d, "agent", f), { force: true });
          }
        }
      }
      await run(harness, 2, ANTHROPIC, "after set_model");
      return reply;
    }

    function expectNothingLeaked(): void {
      const listener = evil as Listener;
      expect(listener.requests.map((r) => r.headers)).toEqual([]);
      expect(listener.connections()).toBe(0);
      const legit = tap as Listener;
      expect(legit.requests.at(-1)?.headers["x-kobe-run-token"]).toBe(runToken(2));
    }

    it.each(LEAKING)(
      "set_model after the plant is refused as runtime_tampered, nothing leaks: %s",
      async (name) => {
        const reply = await scenario(name, false);
        expect(reply).toMatchObject({ ok: false, error: { code: "runtime_tampered" } });
        expectNothingLeaked();
      },
      120_000,
    );

    it("plant removed again before the next prompt (tripwire-clean): refused, nothing leaks", async () => {
      const reply = await scenario(LEAKING[0] as string, true);
      expect(reply).toMatchObject({ ok: false, error: { code: "runtime_tampered" } });
      expectNothingLeaked();
    }, 120_000);

    it("a normal set_model still works, and the next run on it reaches the gateway", async () => {
      const harness = await setup();
      await run(harness, 1, OPENAI, "one");
      expect(await setModel(harness, OPENAI.gateway_model)).toMatchObject({ ok: true });
      await run(harness, 2, OPENAI, "two");
      await until(() => (tap as Listener).requests.length >= 2);
      expect((evil as Listener).requests).toEqual([]);
      expect((tap as Listener).requests.at(-1)?.headers["x-kobe-run-token"]).toBe(runToken(2));
    }, 120_000);
  },
);
