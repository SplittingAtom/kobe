import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startLocalGateway, type LocalGateway } from "@kobe/model-gateway/testing";
import type { SandboxToServerFrame } from "@kobe/protocol";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelWiring } from "./models/types.js";
import { THREAD, runStart, startHarness, type Harness } from "./testing/harness.js";
import { startTap, type Listener } from "./testing/real-pi-rpc.js";
import { PI_AVAILABLE, PI_BIN, REAL_POLICY_EXTENSION } from "./testing/real-pi.js";

/**
 * KOBE-548 (CT11, spike KOBE-541) with the REAL Pi 1.4, kobe-models and kobe-policy through the
 * real model-gateway shim: `thread.branch_summary` has Pi summarise the branch left (with the
 * summary run's model, id and token) and append a `branch_summary` entry under `to_entry_id`; the
 * next prompt's model context carries the summary. A member typing the command gets nothing.
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
const RUN_TOKEN = { token: "krt1.message-run.mac", expires_at: "2099-01-01T00:00:00Z" };
const SUMMARY_TOKEN = { token: "krt1.summary-run.mac", expires_at: "2099-01-01T00:00:00Z" };
const FOCUS = "keep the colour decision";
const runId = (n: number) => `${n}b7c8d9e-af01-4c12-8d3e-5f6071829304`;

interface Entry {
  readonly type: string;
  readonly id: string;
  readonly parentId: string | null;
  readonly customType?: string;
  readonly summary?: string;
  readonly message?: { readonly role: string; readonly content: unknown };
}

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

type Result = Extract<SandboxToServerFrame, { type: "thread.branch_summary_result" }>;

const text = (e: Entry): string => {
  const content = e.message?.content;
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.map((p: { text?: string }) => p.text ?? "").join("") : "";
};

async function entries(harness: Harness): Promise<Entry[]> {
  const raw = await readFile(path.join(harness.sessions, `${THREAD}.jsonl`), "utf8");
  return raw
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Entry)
    .filter((e) => e.type !== "session");
}

async function run(harness: Harness, id: string, message: string, parent?: string) {
  const started = await harness.server.command(
    runStart(message, {
      run_id: id,
      config: { model: OPENAI },
      run_token: RUN_TOKEN,
      ...(parent === undefined ? {} : { parent_entry_id: parent }),
    }),
    60_000,
  );
  expect(started, JSON.stringify(started)).toMatchObject({ ok: true });
  return started;
}

async function settled(harness: Harness, id: string) {
  await harness.server.waitFor(
    (f) => f.type === "pi.event" && f.run_id === id && f.event.type === "agent_settled",
    60_000,
  );
}

/** The assistant answer to the user message `prompt`. */
function answerTo(all: readonly Entry[], prompt: string): Entry {
  const user = all.find((e) => e.message?.role === "user" && text(e) === prompt);
  const answer = all.find((e) => e.parentId === user?.id && e.message?.role === "assistant");
  if (answer === undefined) throw new Error(`no answer to ${prompt}`);
  return answer;
}

describe.skipIf(!PI_AVAILABLE)("thread.branch_summary in real Pi (KOBE-548)", () => {
  it("appends the summary under to_entry_id and the next prompt sees it", async () => {
    gateway = await startLocalGateway({
      enabledModels: [OPENAI.gateway_model],
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
    const harness = h;
    const server = harness.server;
    expect(server.frames("hello").at(-1)?.capabilities).toContain("thread_branch_summary");
    // A, B on the main path; C branches from A's answer (the agent's kobe.branch marker).
    await run(harness, runId(1), "say A");
    await settled(harness, runId(1));
    await run(harness, runId(2), "say B");
    await settled(harness, runId(2));
    const a = answerTo(await entries(harness), "say A");
    const b = answerTo(await entries(harness), "say B");
    await run(harness, runId(3), "say C", a.id);
    await settled(harness, runId(3));
    const c = answerTo(await entries(harness), "say C");

    // A member typing the command: refused, nothing written, the run ends as handled.
    const before = (await entries(harness)).length;
    const typed = await run(
      harness,
      runId(4),
      `/kobe-branch-summary {"from":"${c.id}","to":"${b.id}"}`,
    );
    expect(typed).toMatchObject({ ok: true, data: { disposition: "handled" } });
    expect((await entries(harness)).filter((e) => e.type === "branch_summary")).toEqual([]);
    expect((await entries(harness)).length).toBe(before);

    const calls = (tap as Listener).requests.length;
    server.send({
      v: 1,
      type: "thread.branch_summary",
      command_id: "summary-1",
      thread_id: THREAD,
      run_id: runId(5),
      from_leaf_entry_id: c.id,
      to_entry_id: b.id,
      focus: FOCUS,
      model: OPENAI,
      run_token: SUMMARY_TOKEN,
    } as never);
    const result = await server.waitFor(
      (f): f is Result => f.type === "thread.branch_summary_result" && f.command_id === "summary-1",
      120_000,
    );
    expect(result, JSON.stringify(result)).toMatchObject({
      ok: true,
      thread_id: THREAD,
      parent_id: b.id,
    });
    const all = await entries(harness);
    const summary = all.find((e) => result.ok && e.id === result.entry_id);
    expect(summary).toMatchObject({ type: "branch_summary", parentId: b.id });
    expect(summary?.summary).toContain("explored a different conversation branch");
    expect(summary?.summary).toContain(FOCUS);
    // The summary call is the summary run's: its id and token.
    const summaryCalls = (tap as Listener).requests.slice(calls);
    expect(summaryCalls.length).toBeGreaterThan(0);
    for (const call of summaryCalls) {
      expect(call.headers["x-kobe-run-id"]).toBe(runId(5));
      expect(call.headers["x-kobe-run-token"]).toBe(SUMMARY_TOKEN.token);
    }

    // The next prompt continues from the summary and its model sees it.
    await run(harness, runId(6), "history?");
    await settled(harness, runId(6));
    const after = await entries(harness);
    const prompt = after.find((e) => e.message?.role === "user" && text(e) === "history?");
    expect(prompt?.parentId).toBe(summary?.id);
    const answer = answerTo(after, "history?");
    expect(text(answer)).toContain("summary of a branch");
    expect(text(answer)).toContain("say B");
    // C only inside the summary, never as a message of its own.
    expect(text(answer)).not.toContain("| user: say C");

    // Nothing left to summarise (the leaf is the summary, the target its parent's sibling path).
    server.send({
      v: 1,
      type: "thread.branch_summary",
      command_id: "summary-2",
      thread_id: THREAD,
      run_id: runId(7),
      from_leaf_entry_id: answer.id,
      to_entry_id: answer.id,
      model: OPENAI,
      run_token: SUMMARY_TOKEN,
    } as never);
    const nothing = await server.waitFor(
      (f): f is Result => f.type === "thread.branch_summary_result" && f.command_id === "summary-2",
      60_000,
    );
    expect(nothing).toMatchObject({ ok: false, error: { code: "nothing_to_summarize" } });
  }, 240_000);
});
