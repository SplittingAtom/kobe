import {
  CONTEXT_MAX_SECTIONS,
  CONTEXT_SECTION_MAX_CHARS,
  THREAD_CONTEXT_MAX_BYTES,
  threadContextResultSchema,
} from "@kobe/protocol";
import { describe, expect, it } from "vitest";
import { finalizeContext, scaleTokens, type ContextFacts } from "./finalize.js";
import type { RawSection } from "./system-prompt.js";

const facts = (promptTokens: number | null): ContextFacts => ({
  source: "model_call",
  exact: true,
  missing: [],
  capturedAt: "2026-10-21T10:00:00.000Z",
  model: "glm-5",
  contextWindow: 200_000,
  promptTokens,
});
const raw = (text: string, over: Partial<RawSection> = {}): RawSection => ({
  kind: "user_message",
  label: "User",
  text,
  ...over,
});

describe("context tokens and caps (KOBE-470)", () => {
  it("scales estimates to the reported total exactly", () => {
    expect(scaleTokens([1, 1, 1], 10)).toEqual([4, 3, 3]);
    expect(scaleTokens([0, 0], 7)).toEqual([0, 7]);
    const scaled = scaleTokens([123, 4567, 89, 1], 50_021);
    expect(scaled.reduce((a, b) => a + b, 0)).toBe(50_021);
  });

  it("totals match the call's prompt tokens (the gauge's number)", () => {
    const result = finalizeContext(
      [
        raw("a".repeat(400), { kind: "system_prompt" }),
        raw("b".repeat(40)),
        raw("", { images: 1 }),
      ],
      facts(5000),
      THREAD_CONTEXT_MAX_BYTES,
    );
    expect(threadContextResultSchema.parse(result)).toBeTruthy();
    expect(result.tokens_basis).toBe("usage");
    expect(result.total_tokens).toBe(5000);
    expect(result.sections.reduce((a, s) => a + s.tokens, 0)).toBe(5000);
    expect(result.sections[2]?.tokens).toBeGreaterThan(result.sections[0]?.tokens ?? 0);
  });

  it("falls back to the estimate when no usage was reported", () => {
    const result = finalizeContext([raw("x".repeat(41))], facts(null), THREAD_CONTEXT_MAX_BYTES);
    expect(result).toMatchObject({ tokens_basis: "estimate", total_tokens: 11 });
  });

  it("cuts long sections with a marker and keeps their whole size", () => {
    const long = "y".repeat(CONTEXT_SECTION_MAX_CHARS + 10);
    const result = finalizeContext([raw(long)], facts(100), THREAD_CONTEXT_MAX_BYTES);
    const section = result.sections[0];
    expect(section?.truncated).toBe(true);
    expect(section?.chars).toBe(long.length);
    expect(section?.text.endsWith("[… 10 more characters not shown]")).toBe(true);
    expect(result.truncated).toBe(true);
  });

  it("keeps every section within the byte budget by cutting the largest", () => {
    const sections = [
      raw("s".repeat(100)),
      ...Array.from({ length: 4 }, () => raw("L".repeat(100_000))),
    ];
    const result = finalizeContext(sections, facts(1000), 200_000);
    const bytes = result.sections.reduce((a, s) => a + Buffer.byteLength(s.text), 0);
    expect(bytes).toBeLessThanOrEqual(200_000);
    expect(result.sections[0]).toMatchObject({ text: "s".repeat(100), truncated: false });
    expect(result.sections[1]?.truncated).toBe(true);
    expect(result.total_tokens).toBe(1000);
  });

  it("leaves out the middle past the section cap and keeps the newest", () => {
    const many = Array.from({ length: CONTEXT_MAX_SECTIONS + 50 }, (_, i) => raw(`m${i}`));
    const result = finalizeContext(many, facts(100_000), THREAD_CONTEXT_MAX_BYTES);
    expect(result.sections).toHaveLength(CONTEXT_MAX_SECTIONS);
    expect(result.omitted_sections).toBe(51);
    expect(result.sections.at(-1)?.text).toBe(`m${CONTEXT_MAX_SECTIONS + 49}`);
    expect(result.sections.find((s) => s.label === "51 sections not shown")?.truncated).toBe(true);
    expect(result.sections.reduce((a, s) => a + s.tokens, 0)).toBe(100_000);
  });

  it("flattens labels to one line", () => {
    const result = finalizeContext([raw("t", { label: "a\nb" })], facts(1), 1000);
    expect(result.sections[0]?.label).toBe("a b");
  });
});
