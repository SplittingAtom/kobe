import { describe, expect, it } from "vitest";
import { THREAD_COMPACT_SUMMARY_MAX_BYTES } from "@kobe/protocol";
import { compactSuccess, piCompactFailure, selectsModel } from "./compact.js";

const GW = "http://model-gateway.kobe.internal:80";
const MODEL = { gatewayModel: "openai/gpt-fake", api: "openai-completions" as const };
const selected = (extra: Record<string, unknown> = {}) => ({
  model: {
    provider: "kobe",
    id: "openai/gpt-fake",
    baseUrl: `${GW}/v1`,
    contextWindow: 200_000,
    maxTokens: 32_000,
    ...extra,
  },
});

describe("selectsModel (KOBE-213)", () => {
  it("accepts the gateway's kobe model of that id", () => {
    expect(selectsModel(selected(), MODEL, GW)).toBe(true);
  });

  it.each([
    ["no model", { model: null }],
    ["another provider", selected({ provider: "openai" })],
    ["another id", selected({ id: "openai/gpt-other" })],
    ["a kobe model served elsewhere (planted, KOBE-169)", selected({ baseUrl: "http://evil/v1" })],
  ])("refuses %s", (_what, state) => {
    expect(selectsModel(state, MODEL, GW)).toBe(false);
  });

  it("requires the server's limits when it sent them", () => {
    const limited = { ...MODEL, limits: { maxOutputTokens: 32_000, contextWindow: 200_000 } };
    expect(selectsModel(selected(), limited, GW)).toBe(true);
    expect(selectsModel(selected({ maxTokens: 16_384 }), limited, GW)).toBe(false);
  });
});

describe("Pi's compact answer on the wire", () => {
  it.each([
    ["Nothing to compact (session too small)", "nothing_to_compact"],
    ["Already compacted", "nothing_to_compact"],
    ["No model selected. Use /model", "model_not_configured"],
    ["Compaction cancelled", "compaction_failed"],
    ["402 budget exhausted", "compaction_failed"],
  ])("maps %j to %s", (error, code) => {
    expect(piCompactFailure(error)).toMatchObject({ ok: false, error: { code } });
  });

  it("caps Pi's text (it is logged server-side only)", () => {
    const reply = piCompactFailure("x".repeat(5000));
    expect(!reply.ok && reply.error.message.length).toBe(2000);
  });

  it("keeps the result in wire casing and drops usage and details", () => {
    expect(
      compactSuccess({
        summary: "S",
        firstKeptEntryId: "e1",
        tokensBefore: 10,
        estimatedTokensAfter: 4,
        usage: { cost: { total: 1 } },
        details: { readFiles: ["/etc/x"] },
      }),
    ).toEqual({
      ok: true,
      summary: "S",
      first_kept_entry_id: "e1",
      tokens_before: 10,
      estimated_tokens_after: 4,
    });
  });

  it("leaves out a summary over the cap (the mirrored entry has it)", () => {
    const big = "x".repeat(THREAD_COMPACT_SUMMARY_MAX_BYTES + 1);
    const reply = compactSuccess({ summary: big, firstKeptEntryId: "e1", tokensBefore: 1 });
    expect(reply).toEqual({ ok: true, first_kept_entry_id: "e1", tokens_before: 1 });
  });

  it("refuses a malformed result", () => {
    expect(compactSuccess({ summary: "S" })).toMatchObject({
      ok: false,
      error: { code: "internal" },
    });
    expect(compactSuccess(null)).toMatchObject({ ok: false });
  });
});
