import { describe, expect, it } from "vitest";
import { topLevelModel, withStreamUsage } from "./body-model.js";

const scan = (v: unknown) =>
  topLevelModel(Buffer.from(typeof v === "string" ? v : JSON.stringify(v)));

describe("topLevelModel", () => {
  it("reads the top-level model, wherever it is among the keys", () => {
    expect(scan({ model: "openai/gpt-x", messages: [] })).toMatchObject({
      ok: true,
      model: "openai/gpt-x",
    });
    expect(
      scan({ messages: [{ role: "user", content: "x" }], stream: true, model: "anthropic/c" }),
    ).toMatchObject({ ok: true, model: "anthropic/c" });
    expect(scan({ contents: [] })).toMatchObject({ ok: true, model: undefined });
    expect(scan(" {\n} ")).toMatchObject({ ok: true, model: undefined });
  });

  it("is not fooled by a decoy model string earlier in the body", () => {
    const decoy = {
      messages: [{ role: "user", content: '"model": "openai/expensive"' }],
      metadata: { model: "openai/expensive", nested: [{ model: "x" }] },
      tools: [{ name: '"model":' }],
      model: "openai/cheap",
    };
    expect(scan(decoy)).toMatchObject({ ok: true, model: "openai/cheap" });
    expect(scan('{"note":"he said \\"model\\": \\"x\\"","model":"a/b"}')).toMatchObject({
      ok: true,
      model: "a/b",
    });
  });

  it("decodes escapes in keys and values", () => {
    expect(scan('{"mod\\u0065l":"a\\/b"}')).toMatchObject({ ok: true, model: "a/b" });
  });

  it("treats any key that decodes to model case-insensitively as the model (as Go does)", () => {
    // Go's encoding/json (and sonic) match keys case-insensitively and take the last match.
    for (const body of [
      '{"model":"a/ok","MODEL":"b/evil"}',
      '{"model":"a/ok","Model":"b/evil"}',
      '{"MoDeL":"b/evil","model":"a/ok"}',
      '{"model":"a/ok","\\u006d\\u006f\\u0064\\u0065\\u006c":"b/evil"}',
      '{"model":"a/ok","\\u004D\\u004f\\u0044\\u0045\\u004c":"b/evil"}',
    ]) {
      expect(scan(body), body).toEqual({ ok: false, reason: "duplicate_model" });
    }
    expect(scan('{"MODEL":"b/x"}')).toMatchObject({ ok: true, model: "b/x" });
    expect(scan('{"\\u006d\\u006f\\u0064\\u0065\\u006c":"c/y"}')).toMatchObject({
      ok: true,
      model: "c/y",
    });
    // Longer keys are not the model, even if they contain it.
    expect(scan('{"model_name":"x","models":"y","model":"a/b"}')).toMatchObject({
      ok: true,
      model: "a/b",
    });
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
    expect(scan(big)).toMatchObject({ ok: true, model: "openai/m" });
  });
});

describe("streaming requests (KOBE-43)", () => {
  const scan = (text: string) => topLevelModel(Buffer.from(text));

  it("reads the last top-level stream key in any case, literal true only", () => {
    expect(scan('{"model":"m","stream":true}')).toMatchObject({
      ok: true,
      model: "m",
      stream: true,
    });
    expect(scan('{"model":"m","stream":"true"}')).toMatchObject({ stream: false });
    expect(scan('{"model":"m","stream":true,"STREAM":false}')).toMatchObject({ stream: false });
    expect(scan('{"model":"m","messages":[{"stream":true}]}')).toMatchObject({ stream: false });
    expect(scan('{"model":"m","Stream":true}')).toMatchObject({ stream: true });
  });

  it("forces include_usage as the object's last member", () => {
    const out = withStreamUsage(
      Buffer.from('{"model":"m","stream":true,"stream_options":{"include_usage":false}}  \n'),
    );
    const text = out.toString();
    expect(text.endsWith(',"stream_options":{"include_usage":true}}')).toBe(true);
    expect(topLevelModel(out)).toMatchObject({ ok: true, model: "m", stream: true });
    expect(withStreamUsage(Buffer.from("{ }")).toString()).toBe(
      '{ "stream_options":{"include_usage":true}}',
    );
  });
});

describe("request facts for charging (KOBE-43 review)", () => {
  const facts = (v: unknown) => topLevelModel(Buffer.from(JSON.stringify(v)));

  it("reads the requested output cap from any SDK's key, the largest winning", () => {
    expect(facts({ model: "m", max_tokens: 100 })).toMatchObject({ maxOutputTokens: 100 });
    expect(facts({ model: "m", max_output_tokens: 7, MAX_COMPLETION_TOKENS: 90 })).toMatchObject({
      maxOutputTokens: 90,
    });
    expect(
      facts({ contents: [], generationConfig: { temperature: 1, maxOutputTokens: 512 } }),
    ).toMatchObject({ maxOutputTokens: 512 });
    // Nested elsewhere, or not a whole number: ignored.
    expect(facts({ model: "m", messages: [{ max_tokens: 5 }], max_tokens: "9" })).toMatchObject({
      maxOutputTokens: undefined,
    });
  });

  it("sees a top-level background: true only", () => {
    expect(facts({ model: "m", background: true })).toMatchObject({ background: true });
    expect(facts({ model: "m", Background: true })).toMatchObject({ background: true });
    expect(facts({ model: "m", background: false })).toMatchObject({ background: false });
    expect(facts({ model: "m", input: [{ background: true }] })).toMatchObject({
      background: false,
    });
  });
});
