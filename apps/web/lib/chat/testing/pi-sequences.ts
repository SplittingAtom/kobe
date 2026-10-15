/**
 * Entry sequences as the real Pi 1.0.0 writes them (KOBE-280), copied from the real-Pi suite
 * `services/sandbox-agent/src/kobe-models.model-change.real-pi.test.ts`, which pins each order.
 * Each line is a Pi session entry without its timestamp; ids are short stand-ins.
 */
import type { ThreadEntry } from "../types";

export interface PiLine {
  readonly type: string;
  readonly id: string;
  readonly parentId: string | null;
  readonly [field: string]: unknown;
}

const OPENAI = "openai/gpt-fake";
const ANTHROPIC = "anthropic/claude-fake";

const modelChange = (id: string, parentId: string | null, modelId: string): PiLine => ({
  type: "model_change",
  id,
  parentId,
  provider: "kobe",
  modelId,
});
const message = (id: string, parentId: string, msg: Record<string, unknown>): PiLine => ({
  type: "message",
  id,
  parentId,
  message: msg,
});
const ask = (id: string, parentId: string, text: string) =>
  message(id, parentId, { role: "user", content: [{ type: "text", text }] });
const answer = (id: string, parentId: string, model: string, text: string) =>
  message(id, parentId, {
    role: "assistant",
    provider: "kobe",
    model,
    content: [{ type: "text", text }],
  });

/** A new session's setup: Pi's first model, the thinking level, the system prompt. */
const SETUP: readonly PiLine[] = [
  modelChange("m0", null, OPENAI),
  { type: "thinking_level_change", id: "t0", parentId: "m0", thinkingLevel: "off" },
  message("s0", "t0", { role: "system", content: "You are Kobe." }),
];

/**
 * "Regenerate with…" another model on the first answer: the agent branches at the prompt's parent
 * (Pi's last setup entry) and Pi records the switch after the agent's `kobe.branch` marker.
 */
export const REGENERATE_FIRST_WITH_OTHER_MODEL: readonly PiLine[] = [
  ...SETUP,
  ask("u1", "s0", "one"),
  answer("a1", "u1", OPENAI, "openai one"),
  { type: "custom", id: "b1", parentId: "s0", customType: "kobe.branch", data: { run_id: "r2" } },
  modelChange("m1", "b1", ANTHROPIC),
  ask("u2", "m1", "one"),
  answer("a2", "u2", ANTHROPIC, "anthropic one"),
];

/** A run on the same model with new limits (KOBE-259): Pi re-selects it and records it again. */
export const SAME_MODEL_RESELECT: readonly PiLine[] = [
  ...SETUP,
  ask("u1", "s0", "one"),
  answer("a1", "u1", OPENAI, "openai one"),
  modelChange("m1", "a1", OPENAI),
  ask("u2", "m1", "two"),
  answer("a2", "u2", OPENAI, "openai two"),
];

/** The lines as the Thread API returns them (camelized, payload verbatim). */
export function threadEntries(lines: readonly PiLine[]): ThreadEntry[] {
  return lines.map((line, i) => ({
    entryId: line.id,
    parentId: line.parentId,
    seq: i + 1,
    type: line.type,
    payload: { ...line },
    payloadOffloaded: false,
    createdAt: "2026-10-15T10:00:00.000Z",
  }));
}
