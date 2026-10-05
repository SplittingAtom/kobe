import { afterEach, describe, expect, it } from "vitest";
import type { SandboxToServerFrame } from "@kobe/protocol";
import {
  FAUX_MODEL_EXTENSION,
  PI_AVAILABLE,
  PI_BIN,
  REAL_POLICY_EXTENSION,
  fauxScript,
} from "./testing/real-pi.js";
import { runStart, startHarness, until, type Harness } from "./testing/harness.js";

/**
 * KOBE-123 against the real pinned Pi: the system prompt reaches the model through
 * `--append-system-prompt <file>`, after Pi's own prompt (so its tool descriptions stay).
 */
type PiEventFrame = Extract<SandboxToServerFrame, { type: "pi.event" }>;

let h: Harness | undefined;
afterEach(async () => {
  expect(h?.server.violations ?? []).toEqual([]);
  await h?.close();
  h = undefined;
});

function assistantTexts(harness: Harness): string[] {
  return (harness.server.frames("pi.event") as PiEventFrame[]).flatMap((f) => {
    const event = f.event as { type?: string; message?: { role?: string; content?: unknown } };
    if (event.type !== "message_end" || event.message?.role !== "assistant") return [];
    const content = event.message.content;
    return Array.isArray(content)
      ? content.map((b: { text?: string }) => b.text ?? "")
      : [String(content)];
  });
}

describe.skipIf(!PI_AVAILABLE)("the agent's system prompt in real Pi (KOBE-123)", () => {
  it("reaches the model, appended to Pi's default prompt", async () => {
    h = await startHarness({
      piBin: PI_BIN,
      env: { KOBE_POLICY_EXTENSION: REAL_POLICY_EXTENSION },
      extensions: [FAUX_MODEL_EXTENSION],
    });
    const prompt = "You are the marker agent. KOBE-PROMPT-MARKER:real-pi `$(id)`";
    const result = await h.server.command(
      runStart(fauxScript([{ echoSystemPrompt: true }]), { config: { system_prompt: prompt } }),
      30_000,
    );
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    await until(() => assistantTexts(h as Harness).some((t) => t.startsWith("SYSTEM:")), 30_000);
    const seen = assistantTexts(h).find((t) => t.startsWith("SYSTEM:")) as string;
    expect(seen).toContain(prompt);
    // Appended, not replaced: Pi's own prompt (tool guidance) comes first and is still there.
    expect(seen.indexOf("bash")).toBeGreaterThan(-1);
    expect(seen.indexOf("bash")).toBeLessThan(seen.indexOf("KOBE-PROMPT-MARKER"));
  }, 60_000);
});
