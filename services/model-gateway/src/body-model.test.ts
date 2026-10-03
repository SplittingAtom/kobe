import { describe, expect, it } from "vitest";
import { topLevelModel } from "./body-model.js";

const scan = (v: unknown) =>
  topLevelModel(Buffer.from(typeof v === "string" ? v : JSON.stringify(v)));

describe("topLevelModel", () => {
  it("reads the top-level model, wherever it is among the keys", () => {
    expect(scan({ model: "openai/gpt-x", messages: [] })).toEqual({
      ok: true,
      model: "openai/gpt-x",
    });
    expect(
      scan({ messages: [{ role: "user", content: "x" }], stream: true, model: "anthropic/c" }),
    ).toEqual({ ok: true, model: "anthropic/c" });
    expect(scan({ contents: [] })).toEqual({ ok: true, model: undefined });
    expect(scan(" {\n} ")).toEqual({ ok: true, model: undefined });
  });

  it("is not fooled by a decoy model string earlier in the body", () => {
    const decoy = {
      messages: [{ role: "user", content: '"model": "openai/expensive"' }],
      metadata: { model: "openai/expensive", nested: [{ model: "x" }] },
      tools: [{ name: '"model":' }],
      model: "openai/cheap",
    };
    expect(scan(decoy)).toEqual({ ok: true, model: "openai/cheap" });
    expect(scan('{"note":"he said \\"model\\": \\"x\\"","model":"a/b"}')).toEqual({
      ok: true,
      model: "a/b",
    });
  });

  it("decodes escapes in keys and values", () => {
    expect(scan('{"mod\\u0065l":"a\\/b"}')).toEqual({ ok: true, model: "a/b" });
  });

  it("refuses duplicates, non-string models and non-objects", () => {
    expect(scan('{"model":"a/b","model":"c/d"}')).toEqual({ ok: false, reason: "duplicate_model" });
    expect(scan({ model: 3 })).toEqual({ ok: false, reason: "bad_model" });
    expect(scan({ model: "" })).toEqual({ ok: false, reason: "bad_model" });
    for (const bad of [
      "",
      "[]",
      "null",
      '{"model":"a"',
      '{"model":"a"} x',
      "{model:1}",
      '{"a":}',
    ]) {
      expect(scan(bad), bad).toEqual({ ok: false, reason: "not_json_object" });
    }
  });

  it("handles megabyte bodies without building them", () => {
    const big = { messages: [{ content: "x".repeat(4_000_000) }], model: "openai/m" };
    expect(scan(big)).toEqual({ ok: true, model: "openai/m" });
  });
});
