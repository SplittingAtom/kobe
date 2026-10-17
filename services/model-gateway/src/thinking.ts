import type { GatewayThinkingRow } from "@kobe/db";
import {
  effectiveThinkingLevel,
  narrowThinkingPolicy,
  thinkingRank,
  type ThinkingLevel,
  type ThinkingPolicy,
} from "@kobe/protocol";
import type { Route } from "./routes.js";

/**
 * Thinking enforcement (KOBE-260; levels and policies in `@kobe/protocol` thinking.ts, mapping
 * table in docs/design/thinking-controls.md). For a sandbox's call to a model with a thinking
 * control, the gateway decides the level (the run's recorded level, else the model's default,
 * clamped to the site and team settings in force now) and writes it into the request in the
 * control's form, replacing whatever the caller sent. Pi and the sandbox cannot raise it.
 *
 * How the request is rewritten: members are **appended** to the JSON object, which Bifrost's Go
 * decoder takes over any earlier key that matches in any letter case (the same rule
 * `withStreamUsage` relies on), so a caller's own `reasoning_effort`, `thinking` or
 * `output_config` never wins. Fields Bifrost does not know (`think`, `chat_template_kwargs`) are
 * dropped by Bifrost: the gateway never forwards `x-bf-passthrough-extra-params`. Gemini's
 * setting sits inside `generationConfig`, so that body is parsed and rewritten instead.
 */

/** The strictest policy per gateway model (several aliases may name one model). */
export function thinkingPolicies(
  rows: readonly GatewayThinkingRow[],
): ReadonlyMap<string, ThinkingPolicy> {
  const out = new Map<string, ThinkingPolicy>();
  for (const row of rows) {
    const policy = narrowThinkingPolicy(
      { control: row.control, allowed: row.allowed, default: row.default, max: row.max },
      row.teamMax,
    );
    const seen = out.get(row.model);
    if (seen === undefined || ceiling(policy) < ceiling(seen)) out.set(row.model, policy);
  }
  return out;
}

const ceiling = (p: ThinkingPolicy): number =>
  p.allowed && p.max !== null ? thinkingRank(p.max) : -1;

/** The route each control is written for: a controlled model is called through its own API. */
const CONTROL_ROUTE: Readonly<Record<ThinkingPolicy["control"], Route["kind"] | undefined>> = {
  none: undefined,
  reasoning_effort: "openai",
  anthropic_adaptive: "anthropic",
  anthropic_effort: "anthropic",
  anthropic_budget: "anthropic",
  gemini_budget: "gemini",
};

/** Anthropic `budget_tokens` per level (the API's minimum is 1,024, below `max_tokens`). */
export const ANTHROPIC_BUDGET: Readonly<Record<ThinkingLevel, number>> = {
  off: 0,
  low: 2_048,
  medium: 8_192,
  high: 24_576,
};
const ANTHROPIC_MIN_BUDGET = 1_024;
/** Gemini `thinkingBudget` per level (0 turns thinking off where the model allows it). */
export const GEMINI_BUDGET: Readonly<Record<ThinkingLevel, number>> = {
  off: 0,
  low: 1_024,
  medium: 8_192,
  high: 24_576,
};

export type ThinkingRewrite =
  | { readonly ok: true; readonly body: Buffer; readonly level: ThinkingLevel | undefined }
  | { readonly ok: false; readonly status: 400; readonly code: string; readonly message: string };

const WS = new Set([0x20, 0x09, 0x0a, 0x0d]);

/** `body` (a JSON object) with `members` (`"k":v,...`) added as its last members. */
export function appendMembers(body: Buffer, members: string): Buffer {
  let end = body.length - 1;
  while (end >= 0 && WS.has(body[end] as number)) end--;
  if (body[end] !== 0x7d) return body;
  let start = end - 1;
  while (start >= 0 && WS.has(body[start] as number)) start--;
  const empty = body[start] === 0x7b;
  return Buffer.concat([body.subarray(0, end), Buffer.from(`${empty ? "" : ","}${members}}`)]);
}

/** The level for one call: the run's, else the model's default, clamped to the policy now. */
export function callThinkingLevel(
  policy: ThinkingPolicy,
  runLevel: ThinkingLevel | undefined,
): ThinkingLevel | undefined {
  return effectiveThinkingLevel(policy, runLevel ?? null);
}

/**
 * The request with the call's thinking level written in the control's form. Count-only routes and
 * models without a control pass unchanged; a controlled model called through another API is
 * refused (its control is only known in its own API's form).
 */
export function applyThinking(
  body: Buffer,
  route: Route,
  policy: ThinkingPolicy | undefined,
  level: ThinkingLevel | undefined,
  /** The request's output cap (`topLevelModel`), for Anthropic's budget. */
  maxOutputTokens: number | undefined,
): ThinkingRewrite {
  if (policy === undefined || policy.control === "none" || level === undefined) {
    return { ok: true, body, level: undefined };
  }
  if (route.path.endsWith("/count_tokens") || route.path.endsWith(":countTokens")) {
    return { ok: true, body, level };
  }
  if (CONTROL_ROUTE[policy.control] !== route.kind) {
    return {
      ok: false,
      status: 400,
      code: "thinking_route_refused",
      message: "This model's thinking is set through its provider's own API; call it there.",
    };
  }
  switch (policy.control) {
    case "reasoning_effort":
      return { ok: true, body: openAiEffort(body, route, level), level };
    case "anthropic_adaptive":
    case "anthropic_effort":
      return { ok: true, body: appendMembers(body, anthropicAdaptive(level)), level };
    case "anthropic_budget":
      return {
        ok: true,
        body: appendMembers(body, anthropicBudget(level, maxOutputTokens)),
        level,
      };
    case "gemini_budget":
      return geminiBudget(body, level);
  }
}

/** OpenAI style: `reasoning_effort` (`none` for off); the Responses API's `reasoning.effort`. */
function openAiEffort(body: Buffer, route: Route, level: ThinkingLevel): Buffer {
  const effort = JSON.stringify(level === "off" ? "none" : level);
  if (route.path === "/v1/responses") {
    return appendMembers(body, `"reasoning":{"effort":${effort}}`);
  }
  // `reasoning: null` first: Bifrost refuses `reasoning.effort` beside `reasoning_effort`.
  return appendMembers(body, `"reasoning":null,"reasoning_effort":${effort}`);
}

/** Anthropic adaptive thinking with an effort; `disabled` for off (only where it can be off). */
function anthropicAdaptive(level: ThinkingLevel): string {
  if (level === "off") return `"thinking":{"type":"disabled"}`;
  return `"thinking":{"type":"adaptive","display":"summarized"},"output_config":{"effort":"${level}"}`;
}

/** Anthropic's older budget form: below the request's `max_tokens`, at least 1,024, else off. */
function anthropicBudget(level: ThinkingLevel, maxOutputTokens: number | undefined): string {
  const cap =
    maxOutputTokens !== undefined && Number.isFinite(maxOutputTokens)
      ? maxOutputTokens - 1
      : Infinity;
  const budget = Math.min(ANTHROPIC_BUDGET[level], cap);
  if (level === "off" || budget < ANTHROPIC_MIN_BUDGET) return `"thinking":{"type":"disabled"}`;
  return `"thinking":{"type":"enabled","budget_tokens":${budget}}`;
}

const GENERATION_KEYS = new Set(["generationconfig", "generation_config"]);
const THINKING_KEYS = new Set(["thinkingconfig", "thinking_config"]);
const fold = (key: string) => key.toUpperCase().toLowerCase();

/** Gemini: `generationConfig.thinkingConfig`, every other generation setting kept. */
function geminiBudget(body: Buffer, level: ThinkingLevel): ThinkingRewrite {
  let json: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(body.toString("utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    json = parsed as Record<string, unknown>;
  } catch {
    return {
      ok: false,
      status: 400,
      code: "invalid_request",
      message: "The body must be a JSON object.",
    };
  }
  const thinkingConfig = { thinkingBudget: GEMINI_BUDGET[level], includeThoughts: level !== "off" };
  const out: Record<string, unknown> = {};
  let placed = false;
  for (const [key, value] of Object.entries(json)) {
    if (!GENERATION_KEYS.has(fold(key))) {
      out[key] = value;
      continue;
    }
    const config =
      value !== null && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(
            Object.entries(value as Record<string, unknown>).filter(
              ([k]) => !THINKING_KEYS.has(fold(k)),
            ),
          )
        : {};
    out[key] = { ...config, thinkingConfig };
    placed = true;
  }
  if (!placed) out.generationConfig = { thinkingConfig };
  return { ok: true, body: Buffer.from(JSON.stringify(out)), level };
}
