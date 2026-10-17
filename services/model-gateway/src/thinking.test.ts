import type { GatewayThinkingRow } from "@kobe/db";
import type { ThinkingLevel } from "@kobe/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { topLevelModel } from "./body-model.js";
import { classify, type Route } from "./routes.js";
import { startLocalGateway, type LocalGateway } from "./testing/local-gateway.js";
import { anthropicBudget, applyThinking, callThinkingLevel, thinkingPolicies } from "./thinking.js";

const route = (method: string, path: string): Route => {
  const r = classify(method, path);
  if (!r) throw new Error(path);
  return r;
};
const CHAT = route("POST", "/v1/chat/completions");
const RESPONSES = route("POST", "/v1/responses");
const MESSAGES = route("POST", "/anthropic/v1/messages");
const GEMINI = route("POST", "/genai/v1beta/models/gemini/g:generateContent");
const GEMINI_STREAM = route("POST", "/genai/v1beta/models/gemini/g:streamGenerateContent");
const body = (o: unknown) => Buffer.from(JSON.stringify(o));

/**
 * The top level as Bifrost's decoder (sonic, Go `encoding/json` semantics) sees it: keys matched
 * case-insensitively (Unicode folding), a repeated key decoded INTO the earlier value (objects
 * merge field by field, anything else is replaced). The review's S1 failure mode.
 */
function goDecode(text: string): Record<string, unknown> {
  const fold = (k: string) => k.toUpperCase().toLowerCase();
  const merge = (a: unknown, b: unknown): unknown => {
    if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a)) {
      // Keys folded, so a field matched in another case decodes into the same one.
      const out = new Map(
        Object.entries(a as Record<string, unknown>).map(([k, v]) => [fold(k), v] as const),
      );
      for (const [k, v] of Object.entries(b as Record<string, unknown>)) {
        out.set(fold(k), merge(out.get(fold(k)), v));
      }
      return Object.fromEntries(out);
    }
    return b;
  };
  // Collect every top-level member in order, duplicates included.
  const members: [string, unknown][] = [];
  const re = /"((?:[^"\\]|\\.)*)"\s*:/g;
  let depth = 0;
  let i = 0;
  const s = text;
  while (i < s.length) {
    const c = s[i];
    if (c === '"') {
      re.lastIndex = i;
      const m = re.exec(s);
      if (m && m.index === i && depth === 1) {
        const key = JSON.parse(`"${m[1]}"`) as string;
        let j = re.lastIndex;
        const start = j;
        let d = 0;
        let inStr = false;
        for (; j < s.length; j++) {
          const ch = s[j];
          if (inStr) {
            if (ch === "\\") j++;
            else if (ch === '"') inStr = false;
          } else if (ch === '"') inStr = true;
          else if (ch === "{" || ch === "[") d++;
          else if (ch === "}" || ch === "]") {
            if (d === 0) break;
            d--;
          } else if (ch === "," && d === 0) break;
        }
        members.push([key, JSON.parse(s.slice(start, j)) as unknown]);
        i = j;
        continue;
      }
      // Skip a string value.
      i++;
      while (i < s.length && s[i] !== '"') i += s[i] === "\\" ? 2 : 1;
      i++;
      continue;
    }
    if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") depth--;
    i++;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of members) out[fold(k)] = merge(out[fold(k)], v);
  return out;
}

const row = (over: Partial<GatewayThinkingRow> = {}): GatewayThinkingRow => ({
  model: "ollama/glm",
  control: "reasoning_effort",
  allowed: true,
  default: "low",
  max: "medium",
  lowest: "off",
  teamMax: null,
  ...over,
});
const policy = (over: Partial<GatewayThinkingRow> = {}) => {
  const p = thinkingPolicies([row(over)]).get(over.model ?? "ollama/glm");
  if (!p) throw new Error("no policy");
  return p;
};
const rewrite = (
  r: Route,
  sent: unknown,
  over: Partial<GatewayThinkingRow>,
  level: ThinkingLevel,
) => {
  const out = applyThinking(body(sent), r, policy(over), level);
  if (!out.ok) throw new Error(out.code);
  return { decoded: goDecode(out.body.toString("utf8")), out };
};

describe("Go-style decoding of the test helper itself", () => {
  it("merges a repeated object key case-insensitively, as the review describes", () => {
    const appended =
      '{"thinking":{"type":"enabled","budget_tokens":9},"THINKING":{"type":"adaptive"}}';
    expect(goDecode(appended).thinking).toEqual({ type: "adaptive", budget_tokens: 9 });
  });
});

describe("thinking policies the gateway enforces (KOBE-260)", () => {
  it("applies the team's narrowing and keeps the strictest alias of a model", () => {
    expect(policy({ teamMax: "low" })).toMatchObject({ max: "low", default: "low" });
    const both = thinkingPolicies([
      row({ max: "high" }),
      row({ allowed: false, default: null, max: null }),
    ]);
    expect(both.get("ollama/glm")).toMatchObject({ allowed: false });
  });

  it("clamps the run's level; a call without a run gets the lowest, an eval the default (S4)", () => {
    expect(callThinkingLevel(policy(), "high")).toBe("medium");
    expect(callThinkingLevel(policy(), undefined)).toBe("off");
    expect(callThinkingLevel(policy({ lowest: "low", default: "low" }), undefined)).toBe("low");
    expect(callThinkingLevel(policy(), undefined, { eval: true })).toBe("low");
    expect(callThinkingLevel(policy({ teamMax: "off" }), "high")).toBe("off");
  });

  it("never writes off for a model that cannot turn thinking off (S2)", () => {
    const o3 = policy({ model: "openai/o3", lowest: "low", default: "low", max: "high" });
    expect(callThinkingLevel(o3, "off")).toBe("low");
    const out = applyThinking(body({ model: "openai/o3" }), CHAT, o3, callThinkingLevel(o3, "off"));
    expect(out.ok && goDecode(out.body.toString()).reasoning_effort).toBe("low");
  });
});

describe("the rewrite removes every caller reasoning field (S1, S6)", () => {
  const SNEAKY = {
    model: "m",
    messages: [{ role: "user", content: "hi" }],
    Reasoning_Effort: "high",
    REASONING: { effort: "high", max_tokens: 99_999, summary: "detailed" },
    reasoning_max_tokens: 99_999,
    THINKING: { type: "enabled", budget_tokens: 99_999 },
    think: true,
    enable_thinking: true,
    chat_template_kwargs: { enable_thinking: true },
    extra_body: { reasoning_effort: "high" },
    extra_params: { thinking: { type: "enabled", budget_tokens: 99_999 } },
    budget_tokens: 99_999,
    // The Kelvin sign: Go folds "K" to "k", so this is "thinking" to Bifrost.
    thinKing: { type: "enabled", budget_tokens: 99_999 },
    Output_Config: { effort: "max" },
  };
  const LEFTOVERS = /99999|"max"|"detailed"|enable_thinking|"think"|extra_|chat_template/;

  it("chat completions: one reasoning_effort, nothing else (non-streaming and streaming)", () => {
    for (const stream of [false, true]) {
      const { decoded, out } = rewrite(CHAT, { ...SNEAKY, stream }, {}, "low");
      expect(decoded.reasoning_effort).toBe("low");
      expect(decoded.reasoning).toBeUndefined();
      expect(decoded.thinking).toBeUndefined();
      expect(decoded.output_config).toBeUndefined();
      expect(out.ok && out.body.toString()).not.toMatch(LEFTOVERS);
      expect(decoded.messages).toEqual(SNEAKY.messages);
    }
  });

  it("responses: a fresh reasoning object, the caller's extra fields gone", () => {
    const { decoded, out } = rewrite(RESPONSES, SNEAKY, {}, "medium");
    expect(decoded.reasoning).toEqual({ effort: "medium" });
    expect(out.ok && out.body.toString()).not.toMatch(LEFTOVERS);
  });

  it("Anthropic adaptive: a caller budget_tokens never survives; the output format is kept", () => {
    const sent = { ...SNEAKY, max_tokens: 16_384, output_config: { format: { type: "json" } } };
    const { decoded, out } = rewrite(MESSAGES, sent, { control: "anthropic_adaptive" }, "medium");
    expect(decoded.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(decoded.output_config).toEqual({ format: { type: "json" }, effort: "medium" });
    expect(out.ok && out.body.toString()).not.toMatch(/budget_tokens/);
    const off = rewrite(MESSAGES, sent, { control: "anthropic_adaptive" }, "off");
    expect(off.decoded.thinking).toEqual({ type: "disabled" });
    expect(off.out.ok && off.out.body.toString()).not.toMatch(/budget_tokens|effort/);
  });

  it("Anthropic budget: only the gateway's budget; off is disabled without a budget", () => {
    const sent = { ...SNEAKY, max_tokens: 16_384 };
    const on = rewrite(MESSAGES, sent, { control: "anthropic_budget" }, "medium");
    expect(on.decoded.thinking).toEqual({ type: "enabled", budget_tokens: 8_192 });
    expect(on.out.ok && on.out.budgetTokens).toBe(8_192);
    const off = rewrite(MESSAGES, sent, { control: "anthropic_budget" }, "off");
    expect(off.decoded.thinking).toEqual({ type: "disabled" });
    expect(off.out.ok && off.out.body.toString()).not.toMatch(/budget_tokens/);
  });

  it("Gemini: thinkingConfig replaced in every generation config, top-level variants removed", () => {
    const sent = {
      contents: [],
      thinkingConfig: { thinkingBudget: 99_999 },
      generationConfig: { maxOutputTokens: 100, thinkingConfig: { thinkingBudget: 99_999 } },
      generation_config: { THINKING_CONFIG: { thinking_budget: 99_999 } },
    };
    for (const r of [GEMINI, GEMINI_STREAM]) {
      const { decoded, out } = rewrite(
        r,
        sent,
        { model: "gemini/g", control: "gemini_budget" },
        "off",
      );
      expect(decoded.generationconfig).toEqual({
        maxOutputTokens: 100,
        thinkingConfig: { thinkingBudget: 0, includeThoughts: false },
      });
      expect(decoded.generation_config).toEqual({
        thinkingConfig: { thinkingBudget: 0, includeThoughts: false },
      });
      expect(decoded.thinkingconfig).toBeUndefined();
      expect(out.ok && out.body.toString()).not.toMatch(/99999/);
    }
  });

  it("refuses a controlled model through another API; leaves others and count calls alone", () => {
    const refused = applyThinking(body({}), MESSAGES, policy(), "low");
    expect(refused).toMatchObject({ ok: false, code: "thinking_route_refused" });
    const sent = body({ model: "m", reasoning_effort: "high" });
    expect(applyThinking(sent, CHAT, undefined, undefined)).toEqual({
      ok: true,
      body: sent,
      level: undefined,
    });
    const count = route("POST", "/anthropic/v1/messages/count_tokens");
    const adaptive = policy({ model: "anthropic/c", control: "anthropic_adaptive" });
    expect(applyThinking(sent, count, adaptive, "low")).toMatchObject({ body: sent });
  });
});

describe("the Anthropic budget leaves room for the answer (S3)", () => {
  const p = { control: "anthropic_budget", lowest: "off" } as const;
  it("caps at max_tokens minus the larger of 1,024 and a quarter", () => {
    expect(anthropicBudget("high", 16_384, p)).toEqual({ type: "enabled", budget_tokens: 12_288 });
    expect(anthropicBudget("high", 65_536, p)).toEqual({ type: "enabled", budget_tokens: 24_576 });
    expect(anthropicBudget("medium", 4_096, p)).toEqual({ type: "enabled", budget_tokens: 3_072 });
    // Exactly the minimum, then too little room: off, or 1,024 for a model that cannot turn off.
    expect(anthropicBudget("low", 2_048, p)).toEqual({ type: "enabled", budget_tokens: 1_024 });
    expect(anthropicBudget("low", 2_000, p)).toEqual({ type: "disabled" });
    expect(anthropicBudget("low", 2_000, { ...p, lowest: "low" })).toEqual({
      type: "enabled",
      budget_tokens: 1_024,
    });
    expect(anthropicBudget("low", 1_024, { ...p, lowest: "low" })).toEqual({ type: "disabled" });
    expect(anthropicBudget("high", undefined, p)).toEqual({
      type: "enabled",
      budget_tokens: 24_576,
    });
  });

  it("reads Anthropic's own max_tokens, not a larger key it ignores", () => {
    const sent = { model: "c", max_tokens: 4_096, max_completion_tokens: 131_072 };
    const { decoded } = rewrite(MESSAGES, sent, { control: "anthropic_budget" }, "high");
    expect(decoded.thinking).toEqual({ type: "enabled", budget_tokens: 3_072 });
  });
});

describe("fallbacks are seen in any case (S5)", () => {
  it("the scanner reports them", () => {
    for (const key of ["fallbacks", "Fallbacks", "FALLBACKS"]) {
      const scanned = topLevelModel(body({ model: "m", [key]: ["openai/x"] }));
      expect(scanned.ok && scanned.fallbacks, key).toBe(true);
    }
    const plain = topLevelModel(body({ model: "m", messages: [{ fallbacks: 1 }] }));
    expect(plain.ok && plain.fallbacks).toBe(false);
  });
});

describe("the gateway enforces the clamp on every sandbox call (KOBE-260 ac-2, ac-3)", () => {
  let gw: LocalGateway | undefined;
  afterEach(async () => {
    await gw?.close();
    gw = undefined;
  });
  const RUN = "6b7c8d9e-af10-4c21-8d3e-4f5a6b7c8d9e";
  const OTHER_RUN = "7c8d9eaf-1021-4d32-9e4f-5a6b7c8d9eaf";
  const levels = new Map<string, ThinkingLevel>([
    [RUN, "high"],
    [OTHER_RUN, "off"],
  ]);

  async function call(
    g: LocalGateway,
    extra: Record<string, unknown>,
    runId?: string,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; json: Record<string, unknown>; text: string }> {
    const r = await fetch(`${g.url}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${g.mintToken()}`,
        ...(runId ? { "x-kobe-run-id": runId } : {}),
        ...headers,
      },
      body: JSON.stringify({
        model: "ollama/glm",
        messages: [{ role: "user", content: "think?" }],
        ...extra,
      }),
    });
    const text = await r.text();
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      // A stream.
    }
    return { status: r.status, json, text };
  }
  const message = (r: { json: Record<string, unknown> }) =>
    (r.json.choices as { message: Record<string, unknown> }[])[0]?.message;
  const start = (over: Partial<Parameters<typeof startLocalGateway>[0]> = {}) =>
    startLocalGateway({
      enabledModels: ["ollama/glm"],
      thinking: [row()],
      runThinking: (id) => levels.get(id),
      ...over,
    });

  it("writes the run's level, clamped, whatever the sandbox asks for", async () => {
    gw = await start();
    const clamped = await call(gw, { reasoning_effort: "high" }, RUN);
    expect(clamped.status).toBe(200);
    expect(message(clamped)?.reasoning_content).toBe("fake reasoning at medium");
    expect(gw.seen.at(-1)?.thinking).toEqual({ reasoning_effort: "medium" });
    // A team narrowing applies at once (next principal read).
    gw.setThinking([row({ teamMax: "low" })]);
    expect(message(await call(gw, { reasoning_effort: "high" }, RUN))?.reasoning_content).toBe(
      "fake reasoning at low",
    );
  });

  it("a call that names no run gets the lowest level, an eval's the default (S4)", async () => {
    gw = await start();
    const noRun = await call(gw, { reasoning_effort: "high" });
    expect(message(noRun)).toEqual({ role: "assistant", content: "fake-openai: thought at none" });
    await gw.close();
    gw = await start({ eval: true });
    expect(message(await call(gw, {}))?.reasoning_content).toBe("fake reasoning at low");
  });

  it("with thinking off, the provider returns no reasoning (ac-3)", async () => {
    gw = await start();
    const off = await call(gw, { reasoning_effort: "high" }, OTHER_RUN);
    expect(message(off)).toEqual({ role: "assistant", content: "fake-openai: thought at none" });
    gw.setThinking([row({ allowed: false, default: null, max: null })]);
    expect(message(await call(gw, { reasoning_effort: "high" }, RUN))).not.toHaveProperty(
      "reasoning_content",
    );
  });

  it("streaming: the rewrite and the usage report both reach the provider", async () => {
    gw = await start();
    const r = await call(
      gw,
      { stream: true, stream_options: { include_usage: false }, Reasoning_Effort: "high" },
      RUN,
    );
    expect(r.status).toBe(200);
    expect(r.text).toContain("fake reasoning at medium");
    const seen = gw.seen.at(-1);
    expect(seen?.includeUsage).toBe(true);
    expect(seen?.body).not.toMatch(/Reasoning_Effort|"high"/);
  });

  it("refuses fallbacks, any case, for every model (S5)", async () => {
    gw = await start({ enabledModels: ["ollama/glm", "openai/plain"], thinking: [row()] });
    for (const key of ["fallbacks", "Fallbacks"]) {
      const r = await fetch(`${gw.url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${gw.mintToken()}` },
        body: JSON.stringify({ model: "openai/plain", messages: [], [key]: ["ollama/glm"] }),
      });
      expect(r.status, key).toBe(400);
      expect(await r.text()).toContain("fallbacks_not_supported");
    }
    expect(gw.seen).toEqual([]);
  });

  it("never forwards a passthrough header, so unknown provider extras stay dropped", async () => {
    gw = await start();
    await call(gw, { chat_template_kwargs: { enable_thinking: true }, think: true }, RUN, {
      "x-bf-passthrough-extra-params": "true",
    });
    const seen = gw.seen.at(-1);
    expect(seen?.bifrostHeaders).toBeUndefined();
    expect(seen?.body).not.toMatch(/chat_template_kwargs|"think"/);
  });

  it("passes models without a control unchanged, and refuses another API for a controlled one", async () => {
    gw = await startLocalGateway({
      enabledModels: ["ollama/glm", "anthropic/c"],
      thinking: [row({ model: "anthropic/c", control: "anthropic_adaptive" })],
    });
    const plain = await call(gw, { reasoning_effort: "high" });
    expect(message(plain)?.reasoning_content).toBe("fake reasoning at high");
    const r = await fetch(`${gw.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${gw.mintToken()}` },
      body: JSON.stringify({ model: "anthropic/c", messages: [] }),
    });
    expect(r.status).toBe(400);
    expect(JSON.stringify(await r.json())).toContain("thinking_route_refused");
  });
});
