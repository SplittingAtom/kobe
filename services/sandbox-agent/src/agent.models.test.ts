import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
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

  it("stops a Pi whose runtime directory a sibling planted into during its start (tripwire)", async () => {
    await start(fakeTokens(TOKEN_1));
    const runtime = path.join(h.dir, "pi-runtime");
    await mkdir(runtime, { recursive: true });
    // A sibling thread's tool polling /tmp/kobe-pi: it writes settings.json the moment the
    // directory appears, between mkdtemp and Pi's start.
    let planted: string | undefined;
    const poll = setInterval(() => {
      void readdir(runtime).then(async (names) => {
        const fresh = names.find((n) => n.startsWith("pi-") && path.join(runtime, n) !== planted);
        if (fresh === undefined) return;
        planted = path.join(runtime, fresh);
        await writeFile(
          path.join(planted, "agent", "settings.json"),
          '{"shellPath":"/tmp/evil"}',
        ).catch(() => undefined);
      });
    }, 1);
    try {
      const result = await h.server.command(runStart("hang", { config: { model: MODEL } }));
      expect(result).toMatchObject({ ok: false, error: { code: "runtime_tampered" } });
      expect((result as { error: { message: string } }).error.message).toContain(
        "agent/settings.json",
      );
    } finally {
      clearInterval(poll);
    }
    // That Pi is gone with its directory; the next run gets a fresh one and works.
    await until(() => planted !== undefined && !existsSync(planted));
    const next = await h.server.command(
      runStart("hang", { run_id: RUN_2, config: { model: MODEL } }),
    );
    expect(next).toMatchObject({ ok: true });
    expect((await h.commandsLog()).filter((c) => c.argv !== undefined)).toHaveLength(2);
  });

  it("stops a Pi whose model file was rewritten before the next prompt (tripwire)", async () => {
    await start(fakeTokens(TOKEN_1));
    await h.server.command(runStart("say:hi", { config: { model: MODEL } }));
    const launch = await launchRecord();
    await h.server.waitFor((f) => f.type === "pi.event" && f.event.type === "agent_settled");
    // After the agent's own end-of-run write landed (else the writer would replace the tampering).
    await until(
      async () => parseModelFile(await readFile(launch.modelFile, "utf8")).run_id === null,
    );
    const tampered = { ...parseModelFile(await readFile(launch.modelFile, "utf8")), run_id: RUN_2 };
    await writeFile(launch.modelFile, JSON.stringify(tampered));
    const result = await h.server.command(
      runStart("say:hi", { run_id: RUN_2, config: { model: MODEL } }),
    );
    expect(result).toMatchObject({ ok: false, error: { code: "runtime_tampered" } });
    await until(() => !existsSync(launch.modelFile));
  });

  it("stops a Pi whose models-store.json holds catalog entries (tripwire)", async () => {
    await start(fakeTokens(TOKEN_1));
    await h.server.command(runStart("say:hi", { config: { model: MODEL } }));
    const launch = await launchRecord();
    await h.server.waitFor((f) => f.type === "pi.event" && f.event.type === "agent_settled");
    // An offline Pi never persists catalog entries: `{}` is Pi's, an entry is planted.
    await writeFile(path.join(launch.agentDir, "models-store.json"), "{}");
    expect(
      await h.server.command(runStart("say:hi", { run_id: RUN_2, config: { model: MODEL } })),
    ).toMatchObject({ ok: true });
    await h.server.waitFor(
      (f) => f.type === "pi.event" && f.run_id === RUN_2 && f.event.type === "agent_settled",
    );
    await writeFile(path.join(launch.agentDir, "models-store.json"), '{"kobe":{"models":[]}}');
    const result = await h.server.command(
      runStart("say:hi", {
        run_id: "4f5a6b7c-8d9e-4fa0-9b2c-3d4e5f607183",
        config: { model: MODEL },
      }),
    );
    expect(result).toMatchObject({ ok: false, error: { code: "runtime_tampered" } });
    expect((result as { error: { message: string } }).error.message).toContain("models-store.json");
  });

  it("stops the Pi it just started when the model file cannot be finished (no leaked process)", async () => {
    let calls = 0;
    const tokens: ModelTokenSource = {
      current: async () => {
        calls += 1;
        if (calls === 2) throw new Error("disk full");
        return TOKEN_1;
      },
      onChange: () => () => undefined,
    };
    await start(tokens);
    const result = await h.server.command(runStart("hang", { config: { model: MODEL } }));
    expect(result).toMatchObject({ ok: false, error: { code: "pi_unavailable" } });
    expect((result as { error: { message: string } }).error.message).toContain("disk full");
    const launch = await launchRecord();
    await until(() => !existsSync(path.dirname(launch.agentDir)));
    // The next run starts a fresh Pi (the first one is gone, not reused).
    expect(
      await h.server.command(runStart("hang", { run_id: RUN_2, config: { model: MODEL } })),
    ).toMatchObject({ ok: true });
    expect((await h.commandsLog()).filter((c) => c.argv !== undefined)).toHaveLength(2);
  });

  it("a token rotated while Pi was being spawned reaches the file (no lost rotation)", async () => {
    const tokens = fakeTokens(TOKEN_1);
    await start(tokens);
    const runtime = path.join(h.dir, "pi-runtime");
    await mkdir(runtime, { recursive: true });
    // Rotate as soon as the per-process directory exists: before the thread attached its file.
    let rotated = false;
    const poll = setInterval(() => {
      void readdir(runtime).then((names) => {
        if (!rotated && names.some((n) => n.startsWith("pi-"))) {
          rotated = true;
          tokens.rotate(TOKEN_2);
        }
      });
    }, 1);
    try {
      await h.server.command(runStart("hang", { config: { model: MODEL } }));
    } finally {
      clearInterval(poll);
    }
    expect(rotated).toBe(true);
    const launch = await launchRecord();
    await until(
      async () => parseModelFile(await readFile(launch.modelFile, "utf8")).token === TOKEN_2,
    );
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

describe("run token delivery (KOBE-118)", () => {
  const GRANT = {
    token: `krt1.${"p".repeat(60)}.${"m".repeat(43)}`,
    expires_at: "2099-01-01T00:00:00.000Z",
  };
  const answerOf = async () => {
    const frame = await h.server.waitFor(
      (f) => f.type === "pi.event" && f.event.type === "kobe_test_run_token_answer",
    );
    return (frame as unknown as { event: { answer: Record<string, unknown> } }).event.answer;
  };

  it("advertises the capability only when models are wired", async () => {
    await start(fakeTokens(TOKEN_1));
    const hello = h.server.received.find((r) => r.frame.type === "hello")?.frame as {
      capabilities?: string[];
    };
    expect(hello.capabilities).toContain("run_token");
  });

  it("answers Pi's token request from memory, never forwards it, never writes it to disk", async () => {
    await start(fakeTokens(TOKEN_1));
    await h.server.command(runStart("run-token", { config: { model: MODEL }, run_token: GRANT }));
    expect(await answerOf()).toMatchObject({ id: "tok-1", value: GRANT.token });
    expect(h.server.received.filter((r) => r.frame.type === "pi.ui_request")).toEqual([]);
    const launch = await launchRecord();
    expect(await readFile(launch.modelFile, "utf8")).not.toContain(GRANT.token);
    expect(JSON.stringify(launch.argv)).not.toContain(GRANT.token);
    expect(JSON.stringify(launch.env)).not.toContain(GRANT.token);
    const files = await readdir(path.dirname(launch.agentDir), { recursive: true });
    for (const f of files) {
      const p = path.join(path.dirname(launch.agentDir), f);
      if ((await stat(p)).isFile()) expect(await readFile(p, "utf8")).not.toContain(GRANT.token);
    }
  });

  it("cancels the request when the run carries no token (older server)", async () => {
    await start(fakeTokens(TOKEN_1));
    await h.server.command(runStart("run-token", { config: { model: MODEL } }));
    expect(await answerOf()).toMatchObject({ id: "tok-1", cancelled: true });
  });

  it("does not keep a run's token for the next run", async () => {
    await start(fakeTokens(TOKEN_1));
    await h.server.command(runStart("hang", { config: { model: MODEL }, run_token: GRANT }));
    await h.server.command({
      type: "run.stop",
      run_id: RUN,
      thread_id: THREAD,
      mode: "abort",
      reason: "user_cancelled",
    });
    await h.server.command({
      ...runStart("run-token", { config: { model: MODEL } }),
      run_id: RUN_2,
    });
    expect(await answerOf()).toMatchObject({ cancelled: true });
  });
});
