import { describe, expect, it } from "vitest";
import {
  EPILOGUE_EVENT_TYPES,
  MAX_SERVER_CALL_TOKEN_TTL_SECONDS,
  SERVER_CALL_AUDIENCE,
  SERVER_CALL_EPILOGUE_MARGIN_MS,
  SERVER_CALL_EPILOGUE_MAX_MS,
  SERVER_CALL_LIMITS,
  SERVER_CALL_REASONING_EFFORT,
  SERVER_CALL_RESPONSE_FORMATS,
  SERVER_CALL_TOKEN_HEADER,
  SERVER_CALL_TOKEN_PURPOSES,
  SKILL_EVAL_JUDGE_RESPONSE_SCHEMA,
  SERVER_CALL_TOKEN_SKEW_SECONDS,
  decideStreamOpen,
  epilogueOpen,
  generatedTitleSchema,
  parseEventPayload,
  serverCallClaimsSchema,
  serverCallRequestSchema,
  type KobeEventType,
  type RunTokenClaims,
  type ServerCallClaims,
} from "./index.js";
import {
  deriveRunTokenKey,
  deriveServerCallTokenKey,
  signRunToken,
  signServerCallToken,
  verifyRunToken,
  verifyServerCallToken,
} from "./node/index.js";
import { EXAMPLE_IDS } from "./testing/index.js";

const NOW = 1_800_000_000;
const MASTER = new Uint8Array(32).fill(7);
const KEY = deriveServerCallTokenKey(MASTER);
const CLAIMS: ServerCallClaims = {
  iss: "kobe-server",
  aud: SERVER_CALL_AUDIENCE,
  purpose: "title",
  team_id: EXAMPLE_IDS.team,
  user_id: EXAMPLE_IDS.user,
  thread_id: EXAMPLE_IDS.thread,
  run_id: EXAMPLE_IDS.run,
  model: "openai/gpt-test",
  max_output_tokens: 48,
  iat: NOW,
  exp: NOW + 30,
  jti: "jti-0123456789abcdef",
};
const BODY = {
  model: "openai/gpt-test",
  messages: [
    { role: "system", content: "Title this conversation in at most six words." },
    { role: "user", content: "How did revenue move by region last quarter?" },
  ],
  max_tokens: 48,
};

describe("server-call token", () => {
  it("names its header and an audience no other token carries", () => {
    expect(SERVER_CALL_TOKEN_HEADER).toBe("x-kobe-server-call");
    expect(SERVER_CALL_AUDIENCE).not.toBe("kobe.model-gateway");
  });

  it("derives a key apart from the run-token key of the same master", () => {
    expect(deriveServerCallTokenKey(MASTER)).toEqual(KEY);
    expect(KEY).not.toEqual(deriveRunTokenKey(MASTER));
    expect(() => deriveServerCallTokenKey(new Uint8Array(8))).toThrow();
  });

  it("round-trips sign and verify", () => {
    const token = signServerCallToken(KEY, CLAIMS);
    expect(token.startsWith("ksc1.")).toBe(true);
    expect(verifyServerCallToken(KEY, token, NOW + 1)).toEqual({ ok: true, claims: CLAIMS });
  });

  it("rejects expiry, a future iat, another key and tampering", () => {
    const token = signServerCallToken(KEY, CLAIMS);
    expect(verifyServerCallToken(KEY, token, NOW + 30)).toEqual({ ok: false, reason: "expired" });
    expect(verifyServerCallToken(KEY, token, NOW - SERVER_CALL_TOKEN_SKEW_SECONDS - 1)).toEqual({
      ok: false,
      reason: "not_yet_valid",
    });
    const other = deriveServerCallTokenKey(new Uint8Array(32).fill(8));
    expect(verifyServerCallToken(other, token, NOW)).toEqual({ ok: false, reason: "bad_mac" });
    const [p, payload, mac] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify({ ...CLAIMS, purpose: "followups" }),
      "utf8",
    ).toString("base64url");
    expect(verifyServerCallToken(KEY, `${p}.${forged}.${mac}`, NOW).ok).toBe(false);
    expect(verifyServerCallToken(KEY, `${p}.${payload}`, NOW)).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(verifyServerCallToken(KEY, "x".repeat(2000), NOW)).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(verifyServerCallToken(KEY, 42, NOW)).toEqual({ ok: false, reason: "malformed" });
  });

  it("never verifies as a run token, and a run token never verifies as one (same master)", () => {
    const runKey = deriveRunTokenKey(MASTER);
    const runClaims: RunTokenClaims = {
      iss: "kobe-server",
      aud: "kobe.model-gateway",
      run_id: EXAMPLE_IDS.run,
      team_id: EXAMPLE_IDS.team,
      sandbox_id: EXAMPLE_IDS.sandbox,
      iat: NOW,
      exp: NOW + 900,
      jti: "jti-0123456789abcdef",
    };
    const runToken = signRunToken(runKey, runClaims).token;
    expect(verifyServerCallToken(KEY, runToken, NOW)).toEqual({ ok: false, reason: "malformed" });
    // Even re-prefixed, the MAC is over another key.
    expect(verifyServerCallToken(KEY, runToken.replace(/^krt1/, "ksc1"), NOW)).toEqual({
      ok: false,
      reason: "bad_mac",
    });
    const serverToken = signServerCallToken(KEY, CLAIMS);
    expect(verifyRunToken(runKey, serverToken, NOW)).toEqual({ ok: false, reason: "malformed" });
    expect(verifyRunToken(runKey, serverToken.replace(/^ksc1/, "krt1"), NOW)).toEqual({
      ok: false,
      reason: "bad_mac",
    });
  });

  it("bounds the TTL and the output cap per purpose", () => {
    const parse = (over: Partial<ServerCallClaims>) =>
      serverCallClaimsSchema.safeParse({ ...CLAIMS, ...over }).success;
    expect(parse({})).toBe(true);
    expect(parse({ exp: NOW + MAX_SERVER_CALL_TOKEN_TTL_SECONDS + 1 })).toBe(false);
    expect(parse({ exp: NOW })).toBe(false);
    // A reasoning model's call may carry the larger cap (KOBE-219 review H1), never more.
    expect(parse({ max_output_tokens: SERVER_CALL_LIMITS.title.reasoning_max_output_tokens })).toBe(
      true,
    );
    expect(
      parse({ max_output_tokens: SERVER_CALL_LIMITS.title.reasoning_max_output_tokens + 1 }),
    ).toBe(false);
    expect(
      parse({
        purpose: "followups",
        max_output_tokens: SERVER_CALL_LIMITS.followups.reasoning_max_output_tokens + 1,
      }),
    ).toBe(false);
    expect(
      parse({
        purpose: "followups",
        max_output_tokens: SERVER_CALL_LIMITS.followups.max_output_tokens,
      }),
    ).toBe(true);
    expect(parse({ aud: "kobe.model-gateway" as typeof SERVER_CALL_AUDIENCE })).toBe(false);
    expect(parse({ purpose: "chat" as "title" })).toBe(false);
    expect(() => signServerCallToken(KEY, { ...CLAIMS, max_output_tokens: 10_000 })).toThrow();
  });

  it("sizes the epilogue window to the longest call plus the margin (calls run concurrently)", () => {
    for (const p of ["title", "followups"] as const) {
      expect(SERVER_CALL_EPILOGUE_MAX_MS).toBeGreaterThanOrEqual(
        SERVER_CALL_LIMITS[p].timeout_ms + SERVER_CALL_EPILOGUE_MARGIN_MS,
      );
    }
    expect(SERVER_CALL_EPILOGUE_MAX_MS).toBe(30_000);
  });

  it("gives reasoning models a bounded headroom and a low effort (KOBE-219 review H1)", () => {
    for (const p of ["title", "followups"] as const) {
      const l = SERVER_CALL_LIMITS[p];
      expect(l.reasoning_max_output_tokens).toBeGreaterThan(l.max_output_tokens);
      expect(l.reasoning_max_output_tokens).toBeLessThanOrEqual(1024);
    }
    expect(SERVER_CALL_LIMITS.title.reasoning_max_output_tokens).toBe(512);
    expect(SERVER_CALL_REASONING_EFFORT).toBe("low");
  });

  it("refuses format characters in a generated title (bidi, zero-width, line separators)", () => {
    for (const bad of ["Rev\u202Eenue", "Rev\u200Benue", "a\u2028b", "a\u0085b", "\u2066x"]) {
      expect(generatedTitleSchema.safeParse(bad).success).toBe(false);
    }
    expect(generatedTitleSchema.safeParse("Analyse des ventes · Q3 ✓").success).toBe(true);
  });

  it("skips follow-ups at 80 % and titles only at 100 % (CE21)", () => {
    expect(SERVER_CALL_LIMITS.followups.skip_at_percent).toBe(80);
    expect(SERVER_CALL_LIMITS.title.skip_at_percent).toBe(100);
  });

  it("carries the eval judge's purpose, never announced in an epilogue (KOBE-326)", () => {
    const parse = (over: Partial<ServerCallClaims>) =>
      serverCallClaimsSchema.safeParse({ ...CLAIMS, ...over }).success;
    expect(SERVER_CALL_TOKEN_PURPOSES).toEqual(["title", "followups", "eval_judge"]);
    expect(parse({ purpose: "eval_judge", max_output_tokens: 512 })).toBe(true);
    expect(
      parse({
        purpose: "eval_judge",
        max_output_tokens: SERVER_CALL_LIMITS.eval_judge.reasoning_max_output_tokens + 1,
      }),
    ).toBe(false);
    expect(Object.keys(EPILOGUE_EVENT_TYPES)).toEqual(["title", "followups"]);
    expect(() =>
      parseEventPayload("run.completed", { leaf_entry_id: null, epilogue: ["eval_judge"] }),
    ).toThrow();
    // The judge runs at temperature 0 under its own, longer timeout; epilogue calls keep theirs.
    expect(SERVER_CALL_LIMITS.eval_judge).toMatchObject({
      temperature: 0,
      timeout_ms: 60_000,
      skip_at_percent: 100,
    });
    expect(SERVER_CALL_EPILOGUE_MAX_MS).toBe(30_000);
  });
});

describe("server-call request body", () => {
  const ok = (over: Record<string, unknown>) =>
    serverCallRequestSchema.safeParse({ ...BODY, ...over }).success;

  it("accepts a plain chat completion", () => {
    expect(ok({})).toBe(true);
    expect(
      ok({ max_tokens: undefined, max_completion_tokens: 48, reasoning_effort: "minimal" }),
    ).toBe(true);
  });

  it("refuses tools, tool messages, images, streaming, n > 1 and unknown fields", () => {
    expect(ok({ tools: [{ type: "function", function: { name: "x" } }] })).toBe(false);
    expect(ok({ tool_choice: "auto" })).toBe(false);
    expect(ok({ functions: [] })).toBe(false);
    expect(ok({ messages: [{ role: "tool", content: "x", tool_call_id: "1" }] })).toBe(false);
    expect(ok({ messages: [{ role: "assistant", content: "x", tool_calls: [{ id: "1" }] }] })).toBe(
      false,
    );
    expect(ok({ messages: [{ role: "user", content: [{ type: "image_url" }] }] })).toBe(false);
    expect(ok({ stream: true })).toBe(false);
    expect(ok({ n: 2 })).toBe(false);
    expect(ok({ web_search_options: {} })).toBe(false);
  });

  it("takes a long message and the judge's structured format by shape (the gateway checks the purpose)", () => {
    const long = "x".repeat(SERVER_CALL_LIMITS.eval_judge.max_message_chars);
    expect(ok({ messages: [{ role: "user", content: long }] })).toBe(true);
    expect(ok({ messages: [{ role: "user", content: `${long}x` }] })).toBe(false);
    expect(ok({ response_format: SERVER_CALL_RESPONSE_FORMATS.eval_judge })).toBe(true);
    expect(SERVER_CALL_RESPONSE_FORMATS.eval_judge.json_schema.schema).toBe(
      SKILL_EVAL_JUDGE_RESPONSE_SCHEMA,
    );
    expect(ok({ response_format: { type: "json_object" } })).toBe(false);
    expect(
      ok({
        response_format: {
          ...SERVER_CALL_RESPONSE_FORMATS.eval_judge,
          json_schema: { name: "v", strict: false, schema: {} },
        },
      }),
    ).toBe(false);
  });

  it("needs exactly one output limit", () => {
    expect(ok({ max_tokens: undefined })).toBe(false);
    expect(ok({ max_completion_tokens: 48 })).toBe(false);
  });
});

describe("epilogue events", () => {
  it("validates thread.updated and thread.suggestions, and run.completed.epilogue", () => {
    expect(
      parseEventPayload("thread.updated", { thread_id: EXAMPLE_IDS.thread, title: "Revenue" }),
    ).toEqual({ thread_id: EXAMPLE_IDS.thread, title: "Revenue" });
    expect(() =>
      parseEventPayload("thread.updated", { thread_id: EXAMPLE_IDS.thread, title: "a\nb" }),
    ).toThrow();
    expect(() =>
      parseEventPayload("thread.suggestions", {
        thread_id: EXAMPLE_IDS.thread,
        suggestions: ["a", "b", "c", "d"],
      }),
    ).toThrow();
    expect(
      parseEventPayload("run.completed", { leaf_entry_id: null, epilogue: ["title", "followups"] })
        .epilogue,
    ).toEqual(["title", "followups"]);
    expect(() =>
      parseEventPayload("run.completed", { leaf_entry_id: null, epilogue: ["title", "title"] }),
    ).toThrow();
  });

  it("keeps the stream open until each announced result arrived or the deadline", () => {
    const at = 1_000_000;
    const written = (...t: KobeEventType[]) => new Set<KobeEventType>(t);
    const open = (
      epilogue: ("title" | "followups")[] | undefined,
      w: Set<KobeEventType>,
      now = at,
    ) => epilogueOpen({ epilogue, written: w, completedAtMs: at, nowMs: now });
    expect(open(undefined, written())).toBe(false);
    expect(open(["title"], written())).toBe(true);
    expect(open(["title"], written(EPILOGUE_EVENT_TYPES.title))).toBe(false);
    expect(open(["title", "followups"], written("thread.updated"))).toBe(true);
    expect(open(["title"], written(), at + SERVER_CALL_EPILOGUE_MAX_MS)).toBe(false);
    const base = { ended: true, events_compacted: false, last_seq: 9, cursor: 9 };
    expect(decideStreamOpen(base)).toEqual({ kind: "no_content" });
    expect(decideStreamOpen({ ...base, epilogue_open: true })).toEqual({ kind: "stream" });
    expect(decideStreamOpen({ ...base, events_compacted: true, epilogue_open: true })).toEqual({
      kind: "gone",
    });
  });
});
