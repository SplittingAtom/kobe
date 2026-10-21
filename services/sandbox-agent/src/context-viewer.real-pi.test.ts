import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startLocalGateway, type LocalGateway } from "@kobe/model-gateway/testing";
import { threadContextResultSchema, type SandboxToServerFrame } from "@kobe/protocol";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelWiring } from "./models/types.js";
import { RUN, THREAD, runStart, startHarness, until, type Harness } from "./testing/harness.js";
import { PI_AVAILABLE, PI_BIN, REAL_POLICY_EXTENSION } from "./testing/real-pi.js";

/**
 * KOBE-470 against the REAL pinned Pi 1.0.0: kobe-models records what Pi handed it for the call
 * (the prompt as a leading system message with its tool declarations, then the conversation), and
 * `thread.context` answers it as sections, with the system prompt the agent appended.
 */
const PACKAGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REAL_MODELS_EXTENSION =
  process.env.CI === undefined
    ? path.join(PACKAGE, "src/kobe-models/index.ts")
    : path.join(PACKAGE, "dist/kobe-models/index.js");
if (process.env.CI !== undefined && !existsSync(REAL_MODELS_EXTENSION)) {
  throw new Error(`kobe-models is not built: ${REAL_MODELS_EXTENSION} (run pnpm build first)`);
}
const OPENAI = { alias: "fast", gateway_model: "openai/gpt-fake", api: "openai-completions" };

let h: Harness | undefined;
let gateway: LocalGateway | undefined;
afterEach(async () => {
  expect(h?.server.violations ?? []).toEqual([]);
  await h?.close();
  await gateway?.close();
  h = undefined;
  gateway = undefined;
});

describe.skipIf(!PI_AVAILABLE)("the context viewer's capture in real Pi (KOBE-470)", () => {
  it("answers the latest call's context as Pi sent it to the model", async () => {
    gateway = await startLocalGateway({
      enabledModels: [OPENAI.gateway_model],
      isRunLeased: (runId) => runId === RUN,
      gate: { admit: async () => ({ ok: true }) },
    });
    const token = gateway.mintToken();
    const models: ModelWiring = {
      gatewayUrl: gateway.url,
      extension: REAL_MODELS_EXTENSION,
      tokens: { current: async () => token, onChange: () => () => undefined },
    };
    h = await startHarness({
      piBin: PI_BIN,
      env: { KOBE_POLICY_EXTENSION: REAL_POLICY_EXTENSION },
      models,
    });
    const config = {
      model: OPENAI,
      model_limits: { max_output_tokens: 4096, context_window: 64_000 },
      system_prompt: "You are the context-viewer marker agent.",
    };
    const started = await h.server.command(runStart("hello-context", { config }), 60_000);
    expect(started, JSON.stringify(started)).toMatchObject({ ok: true });
    await h.server.waitFor(
      (f: SandboxToServerFrame) =>
        f.type === "pi.event" && f.run_id === RUN && f.event.type === "agent_settled",
      60_000,
    );
    // The capture is written just after the call ends; until then the session answers.
    const read = async (harness: Harness) => {
      const answer = await harness.server.command(
        { type: "thread.context", thread_id: THREAD, max_bytes: 3 * 1024 * 1024 },
        30_000,
      );
      expect(answer, JSON.stringify(answer)).toMatchObject({ ok: true });
      return threadContextResultSchema.parse((answer as { data?: unknown }).data);
    };
    await until(async () => (await read(h as Harness)).source === "model_call", 10_000);
    const context = await read(h);
    expect(context).toMatchObject({
      source: "model_call",
      model: "openai/gpt-fake",
      context_window: 64_000,
    });
    const kinds = context.sections.map((s) => s.kind);
    expect(kinds[0]).toBe("system_prompt");
    expect(kinds).toContain("tool_definitions");
    expect(context.sections.find((s) => s.kind === "agent_instructions")?.text).toContain(
      "context-viewer marker agent",
    );
    expect(context.sections.at(-1)).toMatchObject({ kind: "user_message", text: "hello-context" });
    expect(context.sections.reduce((a, s) => a + s.tokens, 0)).toBe(context.total_tokens);
  }, 90_000);
});
