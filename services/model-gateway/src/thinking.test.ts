import type { GatewayThinkingRow } from "@kobe/db";
import type { ThinkingLevel } from "@kobe/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { classify, type Route } from "./routes.js";
import { startLocalGateway, type LocalGateway } from "./testing/local-gateway.js";
import { appendMembers, applyThinking, callThinkingLevel, thinkingPolicies } from "./thinking.js";

const route = (method: string, path: string): Route => {
  const r = classify(method, path);
  if (!r) throw new Error(path);
  return r;
};
const CHAT = route("POST", "/v1/chat/completions");
const MESSAGES = route("POST", "/anthropic/v1/messages");
const GEMINI = route("POST", "/genai/v1beta/models/gemini/g:generateContent");
const body = (o: unknown) => Buffer.from(JSON.stringify(o));
/** What Go's decoder (Bifrost) and JSON.parse read: the last member wins. */
const read = (b: Buffer) => JSON.parse(b.toString("utf8")) as Record<string, unknown>;

const row = (over: Partial<GatewayThinkingRow> = {}): GatewayThinkingRow => ({
  model: "ollama/glm",
  control: "reasoning_effort",
  allowed: true,
  default: "low",
  max: "medium",
  teamMax: null,
  ...over,
});
const policy = (over: Partial<GatewayThinkingRow> = {}) => {
  const p = thinkingPolicies([row(over)]).get(over.model ?? "ollama/glm");
  if (!p) throw new Error("no policy");
  return p;
};

describe("thinking policies the gateway enforces (KOBE-260)", () => {
  it("applies the team's narrowing and keeps the strictest alias of a model", () => {
    expect(policy({ teamMax: "low" })).toEqual({
      control: "reasoning_effort",
      allowed: true,
      default: "low",
      max: "low",
    });
    const both = thinkingPolicies([
      row({ max: "high" }),
      row({ allowed: false, default: null, max: null }),
    ]);
    expect(both.get("ollama/glm")).toMatchObject({ allowed: false });
  });

  it("clamps the run's level to the settings in force now", () => {
    expect(callThinkingLevel(policy(), "high")).toBe("medium");
    expect(callThinkingLevel(policy(), undefined)).toBe("low");
    expect(callThinkingLevel(policy({ teamMax: "off" }), "high")).toBe("off");
  });
});

describe("mapping a level to the provider's form", () => {
  it("OpenAI style: reasoning_effort last, none for off, the caller's own fields overridden", () => {
    const sent = body({
      model: "m",
      messages: [],
      reasoning_effort: "high",
      reasoning: { effort: "high" },
    });
    const out = applyThinking(sent, CHAT, policy(), "off", undefined);
    expect(out.ok && read(out.body)).toMatchObject({ reasoning_effort: "none", reasoning: null });
    const low = applyThinking(body({ model: "m" }), CHAT, policy(), "low", undefined);
    expect(low.ok && low.body.toString()).toBe(
      '{"model":"m","reasoning":null,"reasoning_effort":"low"}',
    );
    const responses = applyThinking(
      body({ model: "m" }),
      route("POST", "/v1/responses"),
      policy(),
      "medium",
      undefined,
    );
    expect(responses.ok && read(responses.body).reasoning).toEqual({ effort: "medium" });
  });

  it("Anthropic: adaptive with an effort, disabled for off, or a budget below max_tokens", () => {
    const adaptive = policy({ model: "anthropic/c", control: "anthropic_adaptive" });
    const sent = body({
      model: "c",
      max_tokens: 4096,
      thinking: { type: "enabled", budget_tokens: 9999 },
    });
    const on = applyThinking(sent, MESSAGES, adaptive, "medium", 4096);
    expect(on.ok && read(on.body)).toMatchObject({
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "medium" },
    });
    const off = applyThinking(sent, MESSAGES, adaptive, "off", 4096);
    expect(off.ok && read(off.body).thinking).toEqual({ type: "disabled" });
    const budget = policy({ model: "anthropic/c", control: "anthropic_budget" });
    const high = applyThinking(sent, MESSAGES, budget, "high", 4096);
    expect(high.ok && read(high.body).thinking).toEqual({ type: "enabled", budget_tokens: 4095 });
    const tiny = applyThinking(sent, MESSAGES, budget, "low", 1000);
    expect(tiny.ok && read(tiny.body).thinking).toEqual({ type: "disabled" });
  });

  it("Gemini: thinkingConfig inside generationConfig, the other settings kept", () => {
    const gem = policy({ model: "gemini/g", control: "gemini_budget" });
    const sent = body({
      contents: [],
      generationConfig: { maxOutputTokens: 100, thinkingConfig: { thinkingBudget: 99999 } },
    });
    const off = applyThinking(sent, GEMINI, gem, "off", 100);
    expect(off.ok && read(off.body).generationConfig).toEqual({
      maxOutputTokens: 100,
      thinkingConfig: { thinkingBudget: 0, includeThoughts: false },
    });
    const bare = applyThinking(body({ contents: [] }), GEMINI, gem, "low", undefined);
    expect(bare.ok && read(bare.body).generationConfig).toEqual({
      thinkingConfig: { thinkingBudget: 1024, includeThoughts: true },
    });
  });

  it("refuses a controlled model through another API; leaves others and count calls alone", () => {
    const refused = applyThinking(body({}), MESSAGES, policy(), "low", undefined);
    expect(refused).toMatchObject({ ok: false, code: "thinking_route_refused" });
    const sent = body({ model: "m", reasoning_effort: "high" });
    expect(applyThinking(sent, CHAT, undefined, undefined, undefined)).toEqual({
      ok: true,
      body: sent,
      level: undefined,
    });
    const count = route("POST", "/anthropic/v1/messages/count_tokens");
    const adaptive = policy({ model: "anthropic/c", control: "anthropic_adaptive" });
    expect(applyThinking(sent, count, adaptive, "low", undefined)).toMatchObject({ body: sent });
  });

  it("appends to an empty object and a padded one", () => {
    expect(appendMembers(Buffer.from("{}"), '"a":1').toString()).toBe('{"a":1}');
    expect(appendMembers(Buffer.from('{"x":2} \n'), '"a":1').toString()).toBe('{"x":2,"a":1}');
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

  async function call(
    g: LocalGateway,
    extra: Record<string, unknown>,
    runId?: string,
  ): Promise<{ status: number; json: Record<string, unknown> }> {
    const r = await fetch(`${g.url}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${g.mintToken()}`,
        ...(runId ? { "x-kobe-run-id": runId } : {}),
      },
      body: JSON.stringify({
        model: "ollama/glm",
        messages: [{ role: "user", content: "think?" }],
        ...extra,
      }),
    });
    return { status: r.status, json: (await r.json()) as Record<string, unknown> };
  }
  const message = (r: { json: Record<string, unknown> }) =>
    (r.json.choices as { message: Record<string, unknown> }[])[0]?.message;
  const levels = new Map<string, ThinkingLevel>([
    [RUN, "high"],
    [OTHER_RUN, "off"],
  ]);

  it("writes the run's level, clamped, whatever the sandbox asks for", async () => {
    gw = await startLocalGateway({
      enabledModels: ["ollama/glm"],
      thinking: [row()],
      runThinking: (id) => levels.get(id),
    });
    // The run chose high: the site's maximum (medium) applies, the sandbox's "high" is replaced.
    const clamped = await call(gw, { reasoning_effort: "high" }, RUN);
    expect(clamped.status).toBe(200);
    expect(message(clamped)?.reasoning_content).toBe("fake reasoning at medium");
    expect(gw.seen.at(-1)?.thinking).toMatchObject({ reasoning_effort: "medium" });
    // No run: the model's default.
    expect(message(await call(gw, {}))?.reasoning_content).toBe("fake reasoning at low");
    // A team narrowing applies at once (next principal read).
    gw.setThinking([row({ teamMax: "low" })]);
    expect(message(await call(gw, { reasoning_effort: "high" }, RUN))?.reasoning_content).toBe(
      "fake reasoning at low",
    );
  });

  it("with thinking off, the provider returns no reasoning (ac-3)", async () => {
    gw = await startLocalGateway({
      enabledModels: ["ollama/glm"],
      thinking: [row()],
      runThinking: (id) => levels.get(id),
    });
    const off = await call(gw, { reasoning_effort: "high" }, OTHER_RUN);
    expect(message(off)).toEqual({ role: "assistant", content: "fake-openai: thought at none" });
    gw.setThinking([row({ allowed: false, default: null, max: null })]);
    const siteOff = await call(gw, { reasoning_effort: "high" }, RUN);
    expect(message(siteOff)).not.toHaveProperty("reasoning_content");
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
