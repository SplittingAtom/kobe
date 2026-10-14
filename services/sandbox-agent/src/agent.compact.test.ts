import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SandboxToServerFrame } from "@kobe/protocol";
import { parseModelFile } from "./kobe-models/protocol.js";
import type { ModelWiring } from "./models/types.js";
import { RUN_2, THREAD, runStart, startHarness, until, type Harness } from "./testing/harness.js";

/**
 * `thread.compact` (KOBE-213) with the scripted Pi: Pi's `compact` as the compaction run, the
 * busy refusal under the thread lock, the run's model and token, Stop, and the error mapping.
 */
const TOKEN = "model-token-one-".padEnd(40, "1");
const MODEL = {
  alias: "fast",
  gateway_model: "openai/gpt-fake",
  api: "openai-completions" as const,
};
const OTHER = {
  alias: "slow",
  gateway_model: "openai/gpt-other",
  api: "openai-completions" as const,
};
const GRANT = { token: "krt1.compaction-run-token.mac", expires_at: "2099-01-01T00:00:00Z" };

type Result = Extract<SandboxToServerFrame, { type: "thread.compact_result" }>;

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
function compactFrame(extra: Record<string, unknown> = {}) {
  return {
    v: 1,
    type: "thread.compact",
    command_id: `cmp${++next}`,
    thread_id: THREAD,
    run_id: RUN_2,
    model: MODEL,
    run_token: GRANT,
    ...extra,
  };
}

/** Sends `thread.compact` and waits for its one `thread.compact_result`. */
async function compact(extra: Record<string, unknown> = {}): Promise<Result> {
  const frame = compactFrame(extra);
  h.server.send(frame as never);
  return h.server.waitFor(
    (f): f is Result => f.type === "thread.compact_result" && f.command_id === frame.command_id,
  );
}

const piCommands = async (type: string) => (await h.commandsLog()).filter((c) => c.type === type);
const launches = async () => (await h.commandsLog()).filter((c) => c.argv !== undefined);

describe("thread.compact (KOBE-213)", () => {
  it("is announced only with model wiring", async () => {
    h = await startHarness({ models });
    const hello = await h.server.waitFor((f) => f.type === "hello");
    expect(hello.type === "hello" && hello.capabilities).toContain("thread_compact");
    await h.close();
    h = await startHarness();
    const bare = await h.server.waitFor((f) => f.type === "hello");
    expect(bare.type === "hello" && (bare.capabilities ?? [])).not.toContain("thread_compact");
    // Defence in depth: a frame sent anyway is refused before Pi is touched.
    expect(await compact()).toMatchObject({ ok: false, error: { code: "model_not_configured" } });
  });

  it("compacts an idle thread with the focus as Pi's custom instructions, then ends the run", async () => {
    h = await startHarness({ models });
    const result = await compact({ focus: "keep the API decisions" });
    expect(result).toMatchObject({
      ok: true,
      summary: "Summary. focus=keep the API decisions",
      tokens_before: 1234,
      estimated_tokens_after: 99,
    });
    expect(await piCommands("compact")).toEqual([
      expect.objectContaining({ type: "compact", customInstructions: "keep the API decisions" }),
    ]);
    // The compaction's model was selected before compact (Pi reads it first).
    expect(await piCommands("set_model")).toEqual([
      expect.objectContaining({ provider: "kobe", modelId: MODEL.gateway_model }),
    ]);
    const [launch] = await launches();
    const file = parseModelFile(await readFile(String(launch?.modelFile), "utf8"));
    expect(file.run_id).toBeNull();
    expect(file.model?.gateway_model).toBe(MODEL.gateway_model);
    // Never on disk: the run token is not in the model file.
    expect(await readFile(String(launch?.modelFile), "utf8")).not.toContain(GRANT.token);
    // No focus: Pi gets no custom instructions.
    expect(await compact()).toMatchObject({ ok: true, summary: "Summary." });
    expect((await piCommands("compact"))[1]).not.toHaveProperty("customInstructions");
  });

  it("hands the compaction run's token to kobe-models when Pi asks, from memory", async () => {
    h = await startHarness({ models });
    expect(await compact({ focus: "token" })).toMatchObject({
      ok: true,
      summary: `token:${GRANT.token}`,
    });
  });

  it("refuses thread_busy while a run is active, without touching Pi", async () => {
    h = await startHarness({ models });
    expect(await h.server.command(runStart("hang", { config: { model: MODEL } }))).toMatchObject({
      ok: true,
    });
    expect(await compact()).toMatchObject({ ok: false, error: { code: "thread_busy" } });
    expect(await piCommands("compact")).toEqual([]);
  });

  it("holds the thread for the whole compaction and aborts it on Stop (after_step too)", async () => {
    h = await startHarness({ models });
    const frame = compactFrame({ focus: "hang" });
    h.server.send(frame as never);
    await h.server.waitFor((f) => f.type === "pi.event" && f.event.type === "compaction_start");
    // A run.start arriving mid-compaction is refused: the thread is busy.
    expect(await h.server.command(runStart("say:hi", { config: { model: MODEL } }))).toMatchObject({
      ok: false,
      error: { message: "thread has an active run" },
    });
    // A budget stop asks for after_step, which a compaction never reaches: it aborts instead.
    const stopped = await h.server.command({
      type: "run.stop",
      run_id: RUN_2,
      thread_id: THREAD,
      mode: "after_step",
      reason: "budget_exhausted",
    });
    expect(stopped).toMatchObject({ ok: true });
    const result = await h.server.waitFor(
      (f): f is Result => f.type === "thread.compact_result" && f.command_id === frame.command_id,
    );
    expect(result).toMatchObject({ ok: false, error: { code: "compaction_failed" } });
    expect(await piCommands("abort")).toHaveLength(1);
    // Idle again: a run starts.
    expect(await h.server.command(runStart("say:hi", { config: { model: MODEL } }))).toMatchObject({
      ok: true,
    });
  });

  it.each([
    ["nothing", "nothing_to_compact"],
    ["fail", "compaction_failed"],
  ])("maps Pi's %s answer to %s", async (focus, code) => {
    h = await startHarness({ models });
    expect(await compact({ focus })).toMatchObject({ ok: false, error: { code } });
  });

  it("restarts a Pi that serves another model so the summary uses the compaction's", async () => {
    h = await startHarness({ models });
    await h.server.command(runStart("say:hi", { config: { model: OTHER } }));
    await h.server.waitFor((f) => f.type === "pi.event" && f.event.type === "agent_settled");
    expect(await compact()).toMatchObject({ ok: true });
    expect(await launches()).toHaveLength(2);
    const [, second] = await launches();
    const file = parseModelFile(await readFile(String(second?.modelFile), "utf8"));
    expect(file.model?.gateway_model).toBe(MODEL.gateway_model);
  });

  it("takes the thread before choosing the model: a racing run.start is refused, never switched", async () => {
    h = await startHarness({ models });
    const frame = compactFrame();
    h.server.send(frame as never);
    const started = await h.server.command(runStart("say:hi", { config: { model: OTHER } }));
    expect(started).toMatchObject({ ok: false, error: { message: "thread has an active run" } });
    const result = await h.server.waitFor(
      (f): f is Result => f.type === "thread.compact_result" && f.command_id === frame.command_id,
    );
    expect(result).toMatchObject({ ok: true });
    expect(await piCommands("prompt")).toEqual([]);
    expect(await piCommands("set_model")).toEqual([
      expect.objectContaining({ modelId: MODEL.gateway_model }),
    ]);
  });

  it("refuses steering and Pi commands while compacting", async () => {
    h = await startHarness({ models });
    const frame = compactFrame({ focus: "hang" });
    h.server.send(frame as never);
    await h.server.waitFor((f) => f.type === "pi.event" && f.event.type === "compaction_start");
    expect(
      await h.server.command({ type: "run.steer", run_id: RUN_2, thread_id: THREAD, message: "x" }),
    ).toMatchObject({ ok: false, error: { message: "the thread is compacting" } });
    expect(
      await h.server.command({
        type: "pi.command",
        thread_id: THREAD,
        command: { id: "s", type: "get_state" },
      }),
    ).toMatchObject({ ok: false, error: { message: "the thread is compacting" } });
    await h.server.command({
      type: "run.stop",
      run_id: RUN_2,
      thread_id: THREAD,
      mode: "abort",
      reason: "user_cancelled",
    });
  });

  it("forgets the compaction's token when it fails: a later request is cancelled", async () => {
    h = await startHarness({ models });
    expect(await compact({ focus: "fail-late-token" })).toMatchObject({
      ok: false,
      error: { code: "compaction_failed" },
    });
    const answered = async () =>
      (await h.commandsLog()).find(
        (c) => c.type === "extension_ui_response" && c.id === "tok-late",
      );
    await until(async () => (await answered()) !== undefined);
    expect(await answered()).toEqual({
      type: "extension_ui_response",
      id: "tok-late",
      cancelled: true,
    });
    expect(JSON.stringify(await h.commandsLog())).not.toContain(GRANT.token);
  });

  it("reports runtime_tampered when Pi's config was planted, stopping that Pi before compact", async () => {
    h = await startHarness({ models });
    expect(await compact()).toMatchObject({ ok: true });
    const [launch] = await launches();
    const agentDir = String(launch?.agentDir);
    await rm(path.join(agentDir, "models.json"), { force: true });
    await writeFile(
      path.join(agentDir, "models.json"),
      '{"providers":{"kobe":{"models":[{"id":"x","baseUrl":"http://evil"}]}}}',
    );
    const result = await compact();
    expect(result).toMatchObject({ ok: false, error: { code: "runtime_tampered" } });
    expect(await piCommands("compact")).toHaveLength(1);
    await until(() => !existsSync(agentDir));
  });
});
