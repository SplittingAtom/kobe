import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseModelFile } from "./kobe-models/protocol.js";
import type { ModelTokenSource, ModelWiring } from "./models/types.js";
import {
  RUN,
  RUN_2,
  THREAD,
  FAKE_POLICY_EXTENSION,
  runStart,
  startHarness,
  until,
  type Harness,
} from "./testing/harness.js";

/**
 * Model wiring through the agent (KOBE-41) with the scripted Pi: the private per-process config
 * dir, the model file (token, run id, model), its rotation, and what happens without a model.
 */
const MODELS_EXTENSION = "/opt/kobe/pi-extensions/kobe-models/index.js";
const TOKEN_1 = "model-token-one-".padEnd(40, "1");
const TOKEN_2 = "model-token-two-".padEnd(40, "2");
const MODEL = {
  alias: "fast",
  gateway_model: "openai/gpt-fake",
  api: "openai-completions" as const,
};

function fakeTokens(initial: string): ModelTokenSource & { rotate(token: string): void } {
  let current = initial;
  const listeners = new Set<(token: string) => void>();
  return {
    current: async () => current,
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    rotate(token) {
      current = token;
      for (const l of listeners) l(token);
    },
  };
}

let h: Harness;
afterEach(async () => {
  expect(h.server.violations).toEqual([]);
  await h.close();
});

async function start(tokens: ModelTokenSource) {
  const models: ModelWiring = {
    gatewayUrl: "http://model-gateway.kobe.internal:80",
    extension: MODELS_EXTENSION,
    tokens,
  };
  h = await startHarness({ models });
  return h;
}

async function launchRecord() {
  const [launch] = await h.commandsLog();
  return launch as { argv: string[]; env: string[]; agentDir: string; modelFile: string };
}

describe("model wiring (KOBE-41)", () => {
  it("gives each Pi a private writable config dir and a model file naming the run", async () => {
    await start(fakeTokens(TOKEN_1));
    const result = await h.server.command(runStart("hang", { config: { model: MODEL } }));
    expect(result).toMatchObject({ ok: true });
    const launch = await launchRecord();
    const extensions = launch.argv.flatMap((a, i) =>
      a === "--extension" ? [launch.argv[i + 1]] : [],
    );
    expect(extensions).toEqual([MODELS_EXTENSION, FAKE_POLICY_EXTENSION]);
    expect(launch.argv).not.toContain("--model");
    expect(launch.env.filter((k) => k.startsWith("KOBE_"))).toEqual([
      "KOBE_MODEL_FILE",
      "KOBE_POLICY_FD",
    ]);
    // The config dir: fresh, private (0700), writable, inside the runtime dir, next to the file.
    const runtime = path.join(h.dir, "pi-runtime");
    expect(path.dirname(launch.agentDir)).toMatch(new RegExp(`^${runtime}/pi-`));
    expect(path.dirname(launch.modelFile)).toBe(path.dirname(launch.agentDir));
    expect((await stat(launch.agentDir)).mode & 0o777).toBe(0o700);
    expect((await stat(path.dirname(launch.agentDir))).mode & 0o777).toBe(0o700);
    expect((await stat(launch.modelFile)).mode & 0o777).toBe(0o600);
    expect(parseModelFile(await readFile(launch.modelFile, "utf8"))).toEqual({
      v: 1,
      gateway_url: "http://model-gateway.kobe.internal:80",
      model: { gateway_model: "openai/gpt-fake", api: "openai-completions" },
      token: TOKEN_1,
      run_id: RUN,
    });

    // Run end: the run id is cleared; the model stays for the next prompt.
    await h.server.command({
      type: "run.stop",
      run_id: RUN,
      thread_id: THREAD,
      mode: "abort",
      reason: "user_cancelled",
    });
    await until(
      async () => parseModelFile(await readFile(launch.modelFile, "utf8")).run_id === null,
    );
    expect(parseModelFile(await readFile(launch.modelFile, "utf8")).model).toEqual({
      gateway_model: "openai/gpt-fake",
      api: "openai-completions",
    });
    // Process gone: directory gone (token included).
    await h.agent.stop(500);
    await until(() => !existsSync(path.dirname(launch.agentDir)));
  });

  it("rewrites the file with a rotated token without touching Pi", async () => {
    const tokens = fakeTokens(TOKEN_1);
    await start(tokens);
    await h.server.command(runStart("hang", { config: { model: MODEL } }));
    const launch = await launchRecord();
    tokens.rotate(TOKEN_2);
    await until(
      async () => parseModelFile(await readFile(launch.modelFile, "utf8")).token === TOKEN_2,
    );
    expect(parseModelFile(await readFile(launch.modelFile, "utf8")).run_id).toBe(RUN);
    expect((await h.commandsLog()).filter((c) => c.argv !== undefined)).toHaveLength(1);
  });

  it("keeps the Pi started for a pi.command and gives it the run's model later (no restart)", async () => {
    await start(fakeTokens(TOKEN_1));
    expect(
      await h.server.command({
        type: "pi.command",
        thread_id: THREAD,
        command: { id: "s", type: "get_state" },
      }),
    ).toMatchObject({ ok: true });
    const launch = await launchRecord();
    expect(parseModelFile(await readFile(launch.modelFile, "utf8"))).toMatchObject({
      model: null,
      run_id: null,
    });
    await h.server.command(runStart("hang", { config: { model: MODEL } }));
    expect(parseModelFile(await readFile(launch.modelFile, "utf8"))).toMatchObject({
      model: { gateway_model: "openai/gpt-fake" },
      run_id: RUN,
    });
    expect((await h.commandsLog()).filter((c) => c.argv !== undefined)).toHaveLength(1);
    // A second run on another model: same Pi, new model in the file.
    await h.server.command({
      type: "run.stop",
      run_id: RUN,
      thread_id: THREAD,
      mode: "abort",
      reason: "user_cancelled",
    });
    await h.server.command(
      runStart("hang", {
        run_id: RUN_2,
        config: {
          model: {
            ...MODEL,
            alias: "smart",
            gateway_model: "anthropic/claude-fake",
            api: "anthropic-messages",
          },
        },
      }),
    );
    expect(parseModelFile(await readFile(launch.modelFile, "utf8"))).toMatchObject({
      model: { gateway_model: "anthropic/claude-fake", api: "anthropic-messages" },
      run_id: RUN_2,
    });
    expect((await h.commandsLog()).filter((c) => c.argv !== undefined)).toHaveLength(1);
  });

  it("refuses a run without a gateway model as model_not_configured, before starting Pi", async () => {
    await start(fakeTokens(TOKEN_1));
    const result = await h.server.command(
      runStart("say:hi", { config: { model: { alias: "fast" } } }),
    );
    expect(result).toMatchObject({ ok: false, error: { code: "model_not_configured" } });
    expect(await h.server.command(runStart("say:hi"))).toMatchObject({
      ok: false,
      error: { code: "model_not_configured" },
    });
    expect(existsSync(path.join(h.sessions, `${THREAD}.jsonl.commands.jsonl`))).toBe(false);
  });

  it("without model wiring, Pi gets no model file or extension (as before KOBE-41)", async () => {
    h = await startHarness();
    await h.server.command(runStart("say:hi", { config: { model: MODEL } }));
    const launch = await launchRecord();
    expect(launch.modelFile).toBeNull();
    expect(launch.argv).not.toContain(MODELS_EXTENSION);
    expect(launch.env).toContain("PI_CODING_AGENT_DIR");
    expect(launch.env).not.toContain("KOBE_MODEL_FILE");
    expect((await stat(launch.agentDir)).mode & 0o777).toBe(0o700);
  });
});
