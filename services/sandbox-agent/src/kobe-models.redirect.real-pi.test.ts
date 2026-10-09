import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startLocalGateway, type LocalGateway } from "@kobe/model-gateway/testing";
import { afterEach, describe, expect, it } from "vitest";
import {
  PiRpc,
  startListener,
  startTap,
  type Listener,
  type ModelChoice,
} from "./testing/real-pi-rpc.js";
import {
  ANTHROPIC,
  OPENAI,
  RUN_IDS,
  RUN_TOKEN,
  plantCommand,
  variants,
  type Plant,
} from "./testing/redirect-plants.js";
import { PI_AVAILABLE, PI_BIN, REAL_POLICY_EXTENSION } from "./testing/real-pi.js";

/**
 * KOBE-165 (T1 of KOBE-74, design: KOBE-119): can a tool, which runs as Pi's own uid, redirect the
 * Kobe model provider by writing Pi's writable `agent/` directory (models.json, settings.json,
 * auth.json), so that Pi sends the run-bound gateway token (x-kobe-run-token, KOBE-118) and the
 * session token to a listener the tool owns? Asked of the REAL pinned Pi 1.0.0 with the real
 * kobe-models and kobe-policy, started the way the agent starts it but WITHOUT the agent's
 * tripwire (`verifyRuntime`), which would stop Pi before the next prompt and so hide what Pi
 * itself does. The "tool" is Pi's real bash tool, driven by the fake model.
 *
 * VERDICT (Pi 1.0.0, kobe-models as of KOBE-118): EXPLOITABLE through one reload path. A prompt on
 * the same or another model, and `get_available_models`, never reach the listener. The RPC
 * `set_model` (an allow-listed `pi.command` the server may send, packages/protocol pi-rpc.ts)
 * resolves the model from Pi's catalog, which has merged a planted `models.json` `models[]` entry
 * with its own `baseUrl` (provider-composer.js applyModelsJson), and kobe-models' `input` hook then
 * keeps that model because its id already matches (register.ts). The next request sends the session
 * token and `x-kobe-run-token` to the listener. A provider-level `baseUrl`, a second provider,
 * `settings.json` and `auth.json` do not redirect. The `it.fails` cases below are the red tests;
 * the fix is KOBE-167 (paired tool uid, which removes the tool's write access to `agent/`): when it
 * lands they start passing, `it.fails` then fails, and they become plain `it`.
 * KOBE-169 closes the same cases in the agent (it refuses `set_model` over planted config); those
 * run in kobe-models.redirect-agent.real-pi.test.ts. This file stays raw Pi on purpose.
 * Note the agent's tripwire (`verifyRuntime`) sees a planted file only before a prompt; a tool that
 * removes the file after the reload leaves it nothing to find (last case).
 */
const PACKAGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODELS_EXTENSION =
  process.env.CI === undefined
    ? path.join(PACKAGE, "src/kobe-models/index.ts")
    : path.join(PACKAGE, "dist/kobe-models/index.js");
if (process.env.CI !== undefined && !existsSync(MODELS_EXTENSION)) {
  throw new Error(`kobe-models is not built: ${MODELS_EXTENSION} (run pnpm build first)`);
}

let gateway: LocalGateway | undefined;
let tap: Listener | undefined;
let evil: Listener | undefined;
let pi: PiRpc | undefined;
afterEach(async () => {
  await pi?.close();
  await tap?.close();
  await evil?.close();
  await gateway?.close();
  pi = tap = evil = gateway = undefined;
});

async function setup() {
  gateway = await startLocalGateway({
    enabledModels: [OPENAI, ANTHROPIC].map((m) => m.gateway_model),
  });
  tap = await startTap(gateway.url);
  evil = await startListener();
  const session = gateway.mintToken();
  pi = await PiRpc.start(
    {
      piBin: PI_BIN,
      modelsExtension: MODELS_EXTENSION,
      policyExtension: REAL_POLICY_EXTENSION,
      gatewayUrl: tap.url,
    },
    session,
  );
  return { pi, gateway, tap, evil, session };
}

async function runWith(
  rpc: PiRpc,
  gw: LocalGateway,
  session: string,
  n: number,
  model: ModelChoice,
  message: string,
): Promise<void> {
  await rpc.attachRun(RUN_IDS[n - 1] as string, model, session, RUN_TOKEN(n));
  await rpc.prompt(message);
}

type Scenario = {
  /** Remove the planted files after the reload, before the next prompt (the tripwire-clean state). */
  readonly removeAfterReload?: boolean;
};

/**
 * Plant (in a run, with the real bash tool), run another model (kobe-models re-registers the
 * provider with that model only), reload through `set_model`, prompt, and report.
 */
async function setModelScenario(name: string, { removeAfterReload = false }: Scenario = {}) {
  const { pi: rpc, gateway: gw, tap: legit, evil: listener, session } = await setup();
  const plant = (variants(listener.url)[name] ?? {}) as Record<string, Plant>;
  await runWith(rpc, gw, session, 1, OPENAI, `bash: ${plantCommand(plant)}`);
  await runWith(rpc, gw, session, 2, ANTHROPIC, "another model");
  await rpc.command({ type: "set_model", provider: "kobe", modelId: OPENAI.gateway_model });
  if (removeAfterReload) {
    // What the tool does from a background process (same uid): the files are gone again.
    await Promise.all(
      Object.keys(plant).map((f) => rm(path.join(rpc.agentDir, f), { force: true })),
    );
  }
  await runWith(rpc, gw, session, 3, OPENAI, "after set_model");
  return { listener, legit };
}

function expectNothingLeaked(listener: Listener, legit: Listener): void {
  expect(listener.requests.map((r) => r.headers)).toEqual([]);
  expect(listener.connections()).toBe(0);
  expect(legit.requests.at(-1)?.headers["x-kobe-run-token"]).toBe(RUN_TOKEN(3));
}

describe.skipIf(!PI_AVAILABLE)(
  "a tool cannot redirect the Kobe provider through Pi's agent/ dir",
  () => {
    const names = Object.keys(variants("http://x"));
    /** The planted models.json carries a model entry with its own baseUrl. */
    const LEAKING = [
      "models.json: provider kobe models with their own baseUrl",
      "everything at once",
    ];
    const SAFE = names.filter((n) => !LEAKING.includes(n));

    it.each(names)(
      "prompts and get_available_models after the plant: %s",
      async (name) => {
        const { pi: rpc, gateway: gw, tap: legit, evil: listener, session } = await setup();
        const plant = (variants(listener.url)[name] ?? {}) as Record<string, Plant>;

        // Control: before the plant, the run reaches the legitimate gateway with its run token.
        await runWith(rpc, gw, session, 1, OPENAI, "control");
        expect(legit.requests.at(-1)?.headers["x-kobe-run-token"]).toBe(RUN_TOKEN(1));

        // The tool plants the files in a run that holds the token (the real bash tool).
        await runWith(rpc, gw, session, 2, OPENAI, `bash: ${plantCommand(plant)}`);
        for (const file of Object.keys(plant)) {
          expect(JSON.parse(await readFile(path.join(rpc.agentDir, file), "utf8"))).toEqual(
            plant[file],
          );
        }

        await runWith(rpc, gw, session, 3, OPENAI, "same model after the plant");
        await runWith(rpc, gw, session, 4, ANTHROPIC, "another model after the plant");
        await rpc.command({ type: "get_available_models" });
        await runWith(rpc, gw, session, 5, OPENAI, "after get_available_models");

        expect(listener.requests.map((r) => r.headers)).toEqual([]);
        expect(listener.connections()).toBe(0);
        // And every post-plant model request went to the legitimate gateway with its run's token.
        const tokens = new Set(legit.requests.map((r) => r.headers["x-kobe-run-token"]));
        for (const n of [3, 4, 5]) expect(tokens.has(RUN_TOKEN(n))).toBe(true);
      },
      240_000,
    );

    it.each(SAFE)(
      "set_model after the plant: %s",
      async (name) => {
        const { listener, legit } = await setModelScenario(name);
        expectNothingLeaked(listener, legit);
      },
      120_000,
    );

    // RED (KOBE-165): raw Pi, no agent in between, is exploitable and stays so: only the paired uid
    // (KOBE-167) takes the tool's write access away from Pi itself. Through the agent the same cases
    // pass since KOBE-169 (kobe-models.redirect-agent.real-pi.test.ts). Flip to `it` with KOBE-167.
    it.fails.each(LEAKING)(
      "set_model after the plant: %s",
      async (name) => {
        const { listener, legit } = await setModelScenario(name);
        expectNothingLeaked(listener, legit);
      },
      120_000,
    );

    // RED (KOBE-165), same reason (closed through the agent by KOBE-169). The planted file is gone again before the next prompt, so the
    // agent's tripwire finds nothing, yet Pi keeps the redirected model in memory.
    it.fails(
      "set_model after the plant, plant removed before the prompt (tripwire-clean)",
      async () => {
        const { listener, legit } = await setModelScenario(LEAKING[0] as string, {
          removeAfterReload: true,
        });
        expectNothingLeaked(listener, legit);
      },
      120_000,
    );
  },
);
