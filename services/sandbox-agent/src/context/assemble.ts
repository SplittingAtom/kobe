import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { CONTEXT_MISSING_PARTS, type ThreadContextResult } from "@kobe/protocol";
import {
  CONTEXT_CAPTURE_MAX_BYTES,
  CONTEXT_CAPTURE_VERSION,
  promptUsage,
} from "../kobe-models/context-capture.js";
import { finalizeContext } from "./finalize.js";
import { contextMessages, sectionsOf, type KobePromptParts } from "./sections.js";
import type { ReplayedCall } from "./session-replay.js";

/**
 * The `thread.context` answer (KOBE-470, docs/specs/context-viewer.md CV4): the capture kobe-models
 * wrote for this thread's Pi (`model_call`), else the latest call rebuilt from the session
 * (`session`), else nothing (`none`).
 */
export interface ParsedCapture {
  readonly capturedAt: string;
  readonly model: string;
  readonly contextWindow: number | null;
  readonly promptTokens: number | null;
  readonly context: unknown;
}

type Rec = Record<string, unknown>;
const isRecord = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);

/** The capture file, or undefined when absent, too large, not a regular file or malformed. */
export async function readCapture(file: string): Promise<ParsedCapture | undefined> {
  let handle;
  try {
    // The file is Pi's: never follow a link it may have been swapped for, never block on a FIFO.
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return undefined;
  }
  let text: string;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > CONTEXT_CAPTURE_MAX_BYTES + 64 * 1024) return undefined;
    text = await handle.readFile("utf8");
  } catch {
    return undefined;
  } finally {
    await handle.close();
  }
  return parseCapture(text);
}

export function parseCapture(text: string): ParsedCapture | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || value.v !== CONTEXT_CAPTURE_VERSION || value.too_large === true) {
    return undefined;
  }
  const model = isRecord(value.model) ? value.model : {};
  if (typeof value.captured_at !== "string" || Number.isNaN(Date.parse(value.captured_at))) {
    return undefined;
  }
  if (!isRecord(value.context)) return undefined;
  const window = model.context_window;
  const usage = promptUsage({ usage: value.usage });
  return {
    capturedAt: new Date(value.captured_at).toISOString(),
    model: typeof model.id === "string" ? model.id.slice(0, 256) : "",
    contextWindow:
      typeof window === "number" && Number.isSafeInteger(window) && window > 0 ? window : null,
    promptTokens: usage === null ? null : usage.input + usage.cacheRead + usage.cacheWrite,
    context: value.context,
  };
}

export function fromCapture(
  capture: ParsedCapture,
  parts: KobePromptParts | undefined,
  maxBytes: number,
): ThreadContextResult {
  return finalizeContext(
    sectionsOf(contextMessages(capture.context), parts),
    {
      source: "model_call",
      exact: true,
      missing: [],
      capturedAt: capture.capturedAt,
      model: capture.model === "" ? null : capture.model,
      contextWindow: capture.contextWindow,
      promptTokens: capture.promptTokens,
    },
    maxBytes,
  );
}

const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

function answeredAt(answer: Rec): string | null {
  const ms = answer.timestamp;
  return typeof ms === "number" && Number.isFinite(ms) && ms > 0
    ? new Date(ms).toISOString()
    : null;
}

export function fromSession(
  call: ReplayedCall | undefined,
  contextWindow: number | null,
  maxBytes: number,
): ThreadContextResult {
  const answer = call?.answer ?? null;
  if (call === undefined || answer === null) {
    return finalizeContext(
      [],
      {
        source: "none",
        exact: true,
        missing: [],
        capturedAt: null,
        model: null,
        contextWindow,
        promptTokens: null,
      },
      maxBytes,
    );
  }
  const usage = isRecord(answer.usage) ? answer.usage : {};
  const prompt = count(usage.input) + count(usage.cacheRead) + count(usage.cacheWrite);
  return finalizeContext(
    sectionsOf(call.messages),
    {
      source: "session",
      exact: false,
      // The older history only when the session file was too long to read whole.
      missing: CONTEXT_MISSING_PARTS.filter(
        (p) => p !== "older_history" || call.historyCut === true,
      ),
      capturedAt: answeredAt(answer),
      model: typeof answer.model === "string" ? answer.model.slice(0, 256) : null,
      contextWindow,
      promptTokens: prompt > 0 ? prompt : null,
    },
    maxBytes,
  );
}
