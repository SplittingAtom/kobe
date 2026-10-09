import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startLocalGateway, type LocalGateway } from "@kobe/model-gateway/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { GUARDED_CONFIG, writeGuardedConfig } from "./models/agent-config.js";
import {
  loadPiIdentities,
  partnerOf,
  type PiIdentities,
  type PiIdentity,
} from "./pi/identities.js";
import {
  PiRpc,
  type PiPair,
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
import {
  EXECUTOR_BUILT,
  EXECUTOR_ENTRY,
  PI_AVAILABLE,
  PI_BIN,
  REAL_EXEC_EXTENSION,
  REAL_POLICY_EXTENSION,
} from "./testing/real-pi.js";

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
 * `settings.json` and `auth.json` do not redirect. Those three cases (two plants and the
 * tripwire-clean one) were `it.fails` until KOBE-167: the paired tool uid takes the tool's write
 * access to `agent/` away from Pi itself. They are plain `it` now, in the last `describe`, run with
 * Pi's built-in tools in kobe-exec's executor under the partner uid of Pi's identity (the real
 * `kobe-runas` helper, Linux CI step; skipped where it is not installed). Raw Pi, tools in Pi, is
 * exploitable and stays so: the cases above this block plant from Pi's own uid and only show what
 * Pi itself does with a planted file.
 * KOBE-169 closes the same cases in the agent (it refuses `set_model` over planted config); those
 * run in kobe-models.redirect-agent.real-pi.test.ts.
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

/** The planted models.json carries a model entry with its own baseUrl. */
const LEAKING = ["models.json: provider kobe models with their own baseUrl", "everything at once"];

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

type PiRpcExec = NonNullable<Parameters<typeof PiRpc.start>[0]["exec"]>;

/** How Pi and its tool are set up: the executor, a real Pi identity, and KOBE-169's lock. */
interface Layout {
  readonly exec?: PiRpcExec;
  /** Real identity for Pi with the tools in Pi (no executor): the controls. */
  readonly pair?: PiPair;
  /** The agent's read-only placeholders in agent/ (KOBE-169); default: with them. */
  readonly lock?: boolean;
}

async function setup({ exec, pair, lock = true }: Layout = {}) {
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
      ...(exec === undefined ? {} : { exec }),
      ...(pair === undefined ? {} : { pair }),
      ...((exec !== undefined || pair !== undefined) && lock
        ? { prepareAgentDir: (dir: string) => writeGuardedConfig(dir, true) }
        : {}),
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
  readonly layout?: Layout;
};

/**
 * Plant (in a run, with the real bash tool), run another model (kobe-models re-registers the
 * provider with that model only), reload through `set_model`, prompt, and report.
 */
async function setModelScenario(
  name: string,
  { removeAfterReload = false, layout = {} }: Scenario = {},
) {
  const exec = layout.exec ?? layout.pair;
  const { pi: rpc, gateway: gw, tap: legit, evil: listener, session } = await setup(layout);
  const plant = (variants(listener.url)[name] ?? {}) as Record<string, Plant>;
  // Run by the executor the tool has no PI_CODING_AGENT_DIR: it is given the path outright.
  const command = plantCommand(plant, exec === undefined ? undefined : rpc.agentDir);
  // The tool says who it is first: the proof of which uid made (or failed) the plant.
  const who = `id -u > '${rpc.workspace}/tool-uid'`;
  await runWith(rpc, gw, session, 1, OPENAI, `bash: ${who}; ${command}`);
  await runWith(rpc, gw, session, 2, ANTHROPIC, "another model");
  await rpc.command({ type: "set_model", provider: "kobe", modelId: OPENAI.gateway_model });
  if (removeAfterReload) {
    // What the tool does from a background process: the files are gone again.
    const files = Object.keys(plant);
    if (exec === undefined) {
      await Promise.all(files.map((f) => rm(path.join(rpc.agentDir, f), { force: true })));
    } else {
      const remove = files.map((f) => `rm -f '${rpc.agentDir}/${f}'`).join("; ");
      await runWith(rpc, gw, session, 4, OPENAI, `bash: ${remove}`);
    }
  }
  await runWith(rpc, gw, session, 3, OPENAI, "after set_model");
  return { listener, legit, rpc, plant };
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

    // Control for the KOBE-167 cases below: the same scenario with the tool running in Pi's own
    // uid (and no guarded placeholders) does redirect, so those cases can only pass because the
    // tool is another uid. If Pi ever stops being exploitable here, this says so.
    it("control: with the tool in Pi's uid the planted models.json redirects set_model", async () => {
      const { listener } = await setModelScenario(LEAKING[0] as string);
      expect(listener.requests.length).toBeGreaterThan(0);
      expect(listener.requests[0]?.headers["x-kobe-run-token"]).toBeTruthy();
    }, 120_000);
  },
);

/**
 * KOBE-167: the three cases that were red. Pi runs as a Pi identity and its built-in tools in the
 * executor as the identity's partner uid (the real helper; the agent's directory layout, the
 * guarded placeholders in `agent/`). The plant is attempted for real, with the path handed to the
 * tool, and refused by the kernel: nothing leaks, the guarded files are untouched.
 */
const HELPER = process.env.KOBE_TEST_PI_RUNAS;

describe.runIf(PI_AVAILABLE && EXECUTOR_BUILT && HELPER !== undefined)(
  "a tool in the paired executor cannot redirect the Kobe provider through Pi's agent/ dir (KOBE-167)",
  () => {
    let identities: PiIdentities;
    let identity: PiIdentity;
    let exec: PiRpcExec;
    let umask: number;

    beforeAll(async () => {
      umask = process.umask(0o007);
      identities = await loadPiIdentities(HELPER as string, 1);
      identity = await identities.acquire(1000);
      exec = {
        extension: REAL_EXEC_EXTENSION,
        executorEntry: EXECUTOR_ENTRY,
        pair: { identities, identity, workspaceGid: process.getgid?.() ?? 0 },
      };
    });
    afterAll(async () => {
      process.umask(umask);
      await identities.killAllPatiently(identity, [10, 10]).catch(() => undefined);
      identities.release(identity);
    });

    /** Nothing was planted: the agent's placeholders are what is on disk. */
    async function expectPlantRefused(rpc: PiRpc, plant: Record<string, Plant>, locked = true) {
      for (const file of Object.keys(plant)) {
        const expected = locked ? GUARDED_CONFIG[file] : undefined;
        if (expected !== undefined) {
          expect(await readFile(path.join(rpc.agentDir, file), "utf8"), file).toBe(expected);
        } else if (existsSync(path.join(rpc.agentDir, file))) {
          // A file Pi writes itself (auth.json) may exist; it must not be the tool's.
          // Pi's own file is 0600 to Pi's uid: unreadable here, which a tool's file would not be.
          const text = await readFile(path.join(rpc.agentDir, file), "utf8").catch(
            (error: NodeJS.ErrnoException) => {
              if (error.code === "EACCES") return undefined;
              throw error;
            },
          );
          if (text !== undefined)
            expect(JSON.parse(text) as unknown, file).not.toEqual(plant[file]);
        }
      }
    }

    const toolUid = async (rpc: PiRpc) =>
      Number((await readFile(path.join(rpc.workspace, "tool-uid"), "utf8")).trim());
    const tool = (): PiPair => exec.pair as PiPair;

    // Each protection on its own. Both layouts are the agent's (real Pi identity, sticky agent/).
    // 1. The executor alone (no KOBE-169 placeholders): the plant is attempted by the partner uid
    //    (the tool says so) and fails.
    // 2. KOBE-169's lock alone (the tool is Pi's own uid): refused too.
    // 3. Neither: the same plant by Pi's uid works and redirects. So each stops the attack by itself.
    it.each(LEAKING)(
      "executor on, lock on: the partner uid's plant is refused: %s",
      async (name) => {
        const { listener, legit, rpc, plant } = await setModelScenario(name, {
          layout: { exec },
        });
        expect(await toolUid(rpc)).toBe(partnerOf(identity).uid);
        expectNothingLeaked(listener, legit);
        await expectPlantRefused(rpc, plant);
      },
      180_000,
    );

    // The tripwire-clean case: nothing is planted, so there is nothing to remove or to find.
    it("executor on, lock on: plant removed before the prompt (tripwire-clean)", async () => {
      const { listener, legit, rpc, plant } = await setModelScenario(LEAKING[0] as string, {
        removeAfterReload: true,
        layout: { exec },
      });
      expect(await toolUid(rpc)).toBe(partnerOf(identity).uid);
      expectNothingLeaked(listener, legit);
      await expectPlantRefused(rpc, plant);
    }, 180_000);

    it.each(LEAKING)(
      "executor on, lock OFF: the executor alone stops the plant: %s",
      async (name) => {
        const { listener, legit, rpc, plant } = await setModelScenario(name, {
          layout: { exec, lock: false },
        });
        expect(await toolUid(rpc)).toBe(partnerOf(identity).uid);
        expectNothingLeaked(listener, legit);
        await expectPlantRefused(rpc, plant, false);
      },
      180_000,
    );

    it("executor OFF, lock on: KOBE-169's lock alone stops the plant by Pi's uid", async () => {
      const { listener, legit, rpc, plant } = await setModelScenario(LEAKING[0] as string, {
        layout: { pair: tool() },
      });
      expect(await toolUid(rpc)).toBe(identity.uid);
      expectNothingLeaked(listener, legit);
      await expectPlantRefused(rpc, plant);
    }, 180_000);

    it("control, executor OFF and lock OFF: Pi's uid plants and the token leaks", async () => {
      const { listener, rpc } = await setModelScenario(LEAKING[0] as string, {
        layout: { pair: tool(), lock: false },
      });
      expect(await toolUid(rpc)).toBe(identity.uid);
      expect(listener.requests.length).toBeGreaterThan(0);
      expect(listener.requests[0]?.headers["x-kobe-run-token"]).toBeTruthy();
    }, 180_000);
  },
);
