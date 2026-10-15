import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startLocalGateway, type LocalGateway } from "@kobe/model-gateway/testing";
import type { SandboxToServerFrame } from "@kobe/protocol";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelWiring } from "./models/types.js";
import { RUN, RUN_2, THREAD, runStart, startHarness, type Harness } from "./testing/harness.js";
import { PI_AVAILABLE, PI_BIN, REAL_POLICY_EXTENSION } from "./testing/real-pi.js";

/**
 * KOBE-279 with the REAL Pi 1.0.0 and kobe-models: a run whose model differs from the one its
 * branch is on leaves a `model_change` entry right before its prompt (after the agent's
 * `kobe.branch` marker when it branches), so the chat shows "Model changed to …" there (KOBE-209,
 * KOBE-217); a run on the branch's own model leaves none.
 */
const PACKAGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODELS_EXTENSION =
  process.env.CI === undefined
    ? path.join(PACKAGE, "src/kobe-models/index.ts")
    : path.join(PACKAGE, "dist/kobe-models/index.js");
if (process.env.CI !== undefined && !existsSync(MODELS_EXTENSION)) {
  throw new Error(`kobe-models is not built: ${MODELS_EXTENSION} (run pnpm build first)`);
}

const RUN_3 = "4f5a6b7c-8d9e-4fa0-9b2c-3d4e5f607183";
const RUN_4 = "5a6b7c8d-9eaf-4b01-8c3d-4e5f60718294";
const OPENAI = { alias: "fast", gateway_model: "openai/gpt-fake", api: "openai-completions" };
const ANTHROPIC = {
  alias: "smart",
  gateway_model: "anthropic/claude-fake",
  api: "anthropic-messages",
};

interface Entry {
  readonly type: string;
  readonly id: string;
  readonly parentId: string | null;
  readonly modelId?: string;
  readonly customType?: string;
  readonly message?: { readonly role: string; readonly content: unknown; readonly model?: string };
}

let h: Harness | undefined;
let gateway: LocalGateway | undefined;
afterEach(async () => {
  expect(h?.server.violations ?? []).toEqual([]);
  await h?.close();
  await gateway?.close();
  h = gateway = undefined;
});

async function start(): Promise<Harness> {
  gateway = await startLocalGateway({
    enabledModels: [OPENAI.gateway_model, ANTHROPIC.gateway_model],
    isRunLeased: () => true,
  });
  const session = gateway.mintToken();
  const models: ModelWiring = {
    gatewayUrl: gateway.url,
    extension: MODELS_EXTENSION,
    tokens: { current: async () => session, onChange: () => () => undefined },
  };
  h = await startHarness({
    piBin: PI_BIN,
    env: { KOBE_POLICY_EXTENSION: REAL_POLICY_EXTENSION },
    models,
  });
  return h;
}

interface ModelLimits {
  readonly max_output_tokens: number;
  readonly context_window: number;
}

async function run(
  harness: Harness,
  runId: string,
  message: string,
  model: typeof OPENAI,
  parentEntryId?: string,
  modelLimits?: ModelLimits,
): Promise<void> {
  const extra = {
    run_id: runId,
    config: modelLimits === undefined ? { model } : { model, model_limits: modelLimits },
    ...(parentEntryId === undefined ? {} : { parent_entry_id: parentEntryId }),
  };
  const result = await harness.server.command(runStart(message, extra), 60_000);
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  await harness.server.waitFor(
    (f: SandboxToServerFrame) =>
      f.type === "pi.event" && f.run_id === runId && f.event.type === "agent_settled",
    60_000,
  );
}

async function entries(harness: Harness): Promise<Entry[]> {
  const text = await readFile(path.join(harness.sessions, `${THREAD}.jsonl`), "utf8");
  return text
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Entry)
    .filter((e) => e.type !== "session");
}

/** The path from the root to `leafId`, each entry as a short label. */
function branch(all: readonly Entry[], leafId: string): string[] {
  const byId = new Map(all.map((e) => [e.id, e]));
  const path: string[] = [];
  for (
    let e = byId.get(leafId);
    e !== undefined;
    e = e.parentId ? byId.get(e.parentId) : undefined
  ) {
    path.unshift(label(e));
  }
  return path;
}

function label(e: Entry): string {
  if (e.type === "model_change") return `model_change ${e.modelId}`;
  if (e.type === "custom") return `custom ${e.customType}`;
  if (e.type !== "message" || !e.message) return e.type;
  const { role, content, model } = e.message;
  if (role === "user") {
    const text = typeof content === "string" ? content : JSON.stringify(content);
    return `user ${text.replace(/^.*"text":"([^"]*)".*$/, "$1")}`;
  }
  return `${role} ${model ?? ""}`.trim();
}

const userEntry = (all: readonly Entry[], text: string) =>
  all.filter((e) => e.type === "message" && label(e) === `user ${text}`);
const lastAssistant = (all: readonly Entry[]) =>
  all.filter((e) => e.type === "message" && e.message?.role === "assistant").at(-1) as Entry;

/** The branch after the session's setup entries (thinking level, first model, system). */
const afterSetup = (path: readonly string[]) => path.slice(path.indexOf("user one"));

describe.skipIf(!PI_AVAILABLE)("model_change entries in real Pi (KOBE-279)", () => {
  it("a run on another model records the switch before its prompt; the same model records none (ac-1)", async () => {
    const harness = await start();
    await run(harness, RUN, "one", OPENAI);
    await run(harness, RUN_2, "two", ANTHROPIC);
    await run(harness, RUN_3, "three", ANTHROPIC);
    const all = await entries(harness);
    expect(afterSetup(branch(all, lastAssistant(all).id))).toEqual([
      "user one",
      "assistant openai/gpt-fake",
      "model_change anthropic/claude-fake",
      "user two",
      "assistant anthropic/claude-fake",
      "user three",
      "assistant anthropic/claude-fake",
    ]);
  }, 180_000);

  it("a branch on another model records the switch on the new branch, after its marker (ac-2)", async () => {
    const harness = await start();
    await run(harness, RUN, "one", OPENAI);
    await run(harness, RUN_2, "two", OPENAI);
    const before = await entries(harness);
    const firstAnswer = before.find((e) => label(e) === "assistant openai/gpt-fake") as Entry;
    const oldBranch = branch(before, lastAssistant(before).id);

    // Regenerate "two" with Anthropic: Pi restarts on the branch point (the agent's marker).
    await run(harness, RUN_3, "two", ANTHROPIC, firstAnswer.id);
    let all = await entries(harness);
    expect(afterSetup(branch(all, lastAssistant(all).id))).toEqual([
      "user one",
      "assistant openai/gpt-fake",
      "custom kobe.branch",
      "model_change anthropic/claude-fake",
      "user two",
      "assistant anthropic/claude-fake",
    ]);
    // The old branch is untouched.
    expect(branch(all, lastAssistantOf(all, "two", 0))).toEqual(oldBranch);

    // Again from the same point on the branch's own model (OpenAI, as "one" answered): no entry.
    await run(harness, RUN_4, "two", OPENAI, firstAnswer.id);
    all = await entries(harness);
    expect(afterSetup(branch(all, lastAssistant(all).id))).toEqual([
      "user one",
      "assistant openai/gpt-fake",
      "custom kobe.branch",
      "user two",
      "assistant openai/gpt-fake",
    ]);
    expect(userEntry(all, "two")).toHaveLength(3);
  }, 240_000);

  // KOBE-280: the web's marker fixtures (apps/web/lib/chat/testing/pi-sequences.ts) copy these.
  it("regenerating the first answer on another model branches below the session's setup entries", async () => {
    const harness = await start();
    await run(harness, RUN, "one", OPENAI);
    const before = await entries(harness);
    const prompt = userEntry(before, "one")[0] as Entry;
    const oldBranch = branch(before, lastAssistant(before).id);
    expect(oldBranch).toEqual([
      "model_change openai/gpt-fake",
      "thinking_level_change",
      "system",
      "user one",
      "assistant openai/gpt-fake",
    ]);

    // Regenerate with…: the branch point is the prompt's parent, Pi's last setup entry.
    await run(harness, RUN_2, "one", ANTHROPIC, prompt.parentId as string);
    const all = await entries(harness);
    // One model_change on the new branch; the root one (Pi's setup) is shared by both versions.
    expect(branch(all, lastAssistant(all).id)).toEqual([
      "model_change openai/gpt-fake",
      "thinking_level_change",
      "system",
      "custom kobe.branch",
      "model_change anthropic/claude-fake",
      "user one",
      "assistant anthropic/claude-fake",
    ]);
    expect(branch(all, lastAssistantOf(all, "one", 0))).toEqual(oldBranch);
  }, 180_000);

  it("a limits re-select on the same model records a same-model model_change (KOBE-259)", async () => {
    const harness = await start();
    await run(harness, RUN, "one", OPENAI, undefined, {
      max_output_tokens: 1_000,
      context_window: 100_000,
    });
    await run(harness, RUN_2, "two", OPENAI, undefined, {
      max_output_tokens: 2_000,
      context_window: 100_000,
    });
    const all = await entries(harness);
    expect(afterSetup(branch(all, lastAssistant(all).id))).toEqual([
      "user one",
      "assistant openai/gpt-fake",
      "model_change openai/gpt-fake",
      "user two",
      "assistant openai/gpt-fake",
    ]);
  }, 180_000);
});

/** The assistant entry answering the `n`th prompt with `text`. */
function lastAssistantOf(all: readonly Entry[], text: string, n: number): string {
  const prompt = userEntry(all, text)[n] as Entry;
  return (all.find((e) => e.parentId === prompt.id) as Entry).id;
}
