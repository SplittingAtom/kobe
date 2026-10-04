/**
 * The top-level `"model"` of a JSON request body (KOBE-40 review): scanned structurally (strings,
 * escapes and nesting tracked) so a `"model"` inside a message or a nested object never counts,
 * and without building the whole object (bodies may be megabytes of images). The body must be a
 * JSON object; more than one top-level key that decodes to `model` in any letter case is refused
 * (Bifrost's Go decoder matches keys case-insensitively and takes the last; others take the first).
 */
export type BodyModel =
  | {
      readonly ok: true;
      readonly model: string | undefined;
      /**
       * Whether the request streams: the last top-level key that decodes to `stream` in any case
       * (Go's rule, as for `model`) has the literal value `true` (KOBE-43 usage reporting).
       */
      readonly stream: boolean;
      /** Responses' `background: true` (deferred work billed later; KOBE-43 refuses it). */
      readonly background: boolean;
      /**
       * The output cap the request asks for: top-level `max_tokens`, `max_output_tokens` or
       * `max_completion_tokens`, or Gemini's `generationConfig.maxOutputTokens` (also
       * `generation_config.max_output_tokens`); the largest. A value that is not a plain whole
       * number (`1e5`, `65536.0`, a string) counts as unbounded (`Infinity`): what the upstream
       * may read differently is charged at the ceiling.
       */
      readonly maxOutputTokens: number | undefined;
      /** How many answers the request asks for (`n`, Gemini's `candidateCount`); at least 1. */
      readonly choices: number;
    }
  | { readonly ok: false; readonly reason: "not_json_object" | "duplicate_model" | "bad_model" };

const WS = new Set([0x20, 0x09, 0x0a, 0x0d]);
const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const MAX_MODEL = 200;
const MAX_MODEL_KEY_RAW = 30;
/** Longest raw key decoded for the request facts (a 30-character name, fully `\uXXXX`-escaped). */
const MAX_FACT_KEY_RAW = 180;
const TRUE = Buffer.from("true");
const MAX_OUTPUT_KEYS = new Set(["max_tokens", "max_output_tokens", "max_completion_tokens"]);
const NUMBER = /^[0-9]{1,12}$/;
/** Answers charged for a request whose `n` / `candidateCount` cannot be read plainly. */
export const MAX_CHOICES = 16;
const CONFIG_KEYS = new Set(["generationconfig", "generation_config"]);
const NESTED_MAX_KEYS = new Set(["maxoutputtokens", "max_output_tokens"]);
const CHOICE_KEYS = new Set(["candidatecount", "candidate_count"]);

class Malformed extends Error {}

export function topLevelModel(body: Buffer): BodyModel {
  let i = 0;
  const n = body.length;
  const ws = () => {
    while (i < n && WS.has(body[i] as number)) i++;
  };
  const expect = (ch: number) => {
    if (body[i] !== ch) throw new Malformed();
    i++;
  };
  /** Skips a string starting at `i` (on its opening quote); returns its raw bytes' range. */
  const string = (): [number, number] => {
    expect(QUOTE);
    const start = i;
    while (i < n) {
      const c = body[i] as number;
      if (c === BACKSLASH) i += 2;
      else if (c === QUOTE) return [start, i++];
      else if (c < 0x20) throw new Malformed();
      else i++;
    }
    throw new Malformed();
  };
  /** Skips any JSON value (nesting counted iteratively, strings skipped). */
  const value = () => {
    ws();
    const c = body[i];
    if (c === QUOTE) {
      string();
      return;
    }
    if (c === 0x7b || c === 0x5b) {
      let depth = 0;
      while (i < n) {
        const d = body[i] as number;
        if (d === QUOTE) {
          string();
          continue;
        }
        if (d === 0x7b || d === 0x5b) depth++;
        else if (d === 0x7d || d === 0x5d) {
          depth--;
          if (depth === 0) {
            i++;
            return;
          }
        }
        i++;
      }
      throw new Malformed();
    }
    const start = i;
    while (i < n && !WS.has(body[i] as number) && body[i] !== 0x2c && body[i] !== 0x7d) i++;
    if (i === start) throw new Malformed();
  };
  const decode = (start: number, end: number): string =>
    JSON.parse(body.subarray(start - 1, end + 1).toString("utf8")) as string;
  /**
   * Go's JSON decoding (Bifrost) matches keys case-insensitively and takes the last match, so
   * every key that decodes to "model" in any case counts. "model" is 5 characters, at most 6 raw
   * bytes each (`\uXXXX`): longer raw keys cannot be it and are not decoded.
   */
  const isModelKey = (start: number, end: number): boolean =>
    end - start <= MAX_MODEL_KEY_RAW && decode(start, end).toUpperCase().toLowerCase() === "model";
  /** A key's name in lower case (Go's case-insensitive match), or "" when too long to matter. */
  const keyName = (start: number, end: number): string =>
    end - start <= MAX_FACT_KEY_RAW ? decode(start, end).toUpperCase().toLowerCase() : "";
  /** A value's raw text (any JSON value; strings keep their quotes). */
  const raw = (): string => {
    const vs = i;
    value();
    return body.subarray(vs, i).toString("latin1");
  };
  /** A plain whole number, `null` (unset) or anything else (read as unbounded). */
  const whole = (text: string): number | null =>
    text === "null" ? null : NUMBER.test(text) ? Number(text) : Number.POSITIVE_INFINITY;
  let maxOutput: number | undefined;
  let choices = 1;
  const noteMax = (text: string) => {
    const n = whole(text);
    if (n !== null) maxOutput = Math.max(maxOutput ?? 0, n);
  };
  const noteChoices = (text: string) => {
    const n = whole(text);
    if (n !== null) choices = Math.max(choices, Math.min(n, MAX_CHOICES));
  };
  /** Gemini's generation config: only its output cap and candidate count matter. */
  const generationConfig = () => {
    if (body[i] !== 0x7b) {
      value();
      return;
    }
    expect(0x7b);
    ws();
    if (body[i] === 0x7d) {
      i++;
      return;
    }
    for (;;) {
      ws();
      const [ks, ke] = string();
      const name = keyName(ks, ke);
      ws();
      expect(0x3a);
      ws();
      if (NESTED_MAX_KEYS.has(name)) noteMax(raw());
      else if (CHOICE_KEYS.has(name)) noteChoices(raw());
      else value();
      ws();
      if (body[i] === 0x2c) {
        i++;
        continue;
      }
      expect(0x7d);
      return;
    }
  };

  try {
    ws();
    expect(0x7b);
    ws();
    let model: string | undefined;
    let seen = false;
    let stream = false;
    let background = false;
    if (body[i] === 0x7d) {
      i++;
    } else {
      for (;;) {
        ws();
        const [ks, ke] = string();
        const isModel = isModelKey(ks, ke);
        const name = isModel ? "model" : keyName(ks, ke);
        ws();
        expect(0x3a);
        ws();
        if (isModel) {
          if (seen) return { ok: false, reason: "duplicate_model" };
          seen = true;
          if (body[i] !== QUOTE) {
            return { ok: false, reason: "bad_model" };
          }
          const [vs, ve] = string();
          if (ve - vs > MAX_MODEL * 6) return { ok: false, reason: "bad_model" };
          model = decode(vs, ve);
          if (model.length === 0 || model.length > MAX_MODEL)
            return { ok: false, reason: "bad_model" };
        } else if (name === "stream" || name === "background") {
          const vs = i;
          value();
          const isTrue = body.subarray(vs, i).equals(TRUE);
          if (name === "stream") stream = isTrue;
          else background = isTrue;
        } else if (MAX_OUTPUT_KEYS.has(name)) {
          noteMax(raw());
        } else if (name === "n") {
          noteChoices(raw());
        } else if (CONFIG_KEYS.has(name)) {
          generationConfig();
        } else {
          value();
        }
        ws();
        if (body[i] === 0x2c) {
          i++;
          continue;
        }
        expect(0x7d);
        break;
      }
    }
    ws();
    if (i !== n) throw new Malformed();
    return { ok: true, model, stream, background, maxOutputTokens: maxOutput, choices };
  } catch (err) {
    if (err instanceof Malformed || err instanceof SyntaxError) {
      return { ok: false, reason: "not_json_object" };
    }
    throw err;
  }
}

/**
 * A Chat Completions body that streams, with `stream_options.include_usage` forced on (KOBE-43):
 * appended as the object's last member, which Go's decoder (Bifrost) takes over any earlier
 * `stream_options` in any letter case. Without it OpenAI-style streams carry no usage report.
 * `body` must be a JSON object already accepted by {@link topLevelModel}.
 */
export function withStreamUsage(body: Buffer): Buffer {
  let end = body.length - 1;
  while (end >= 0 && WS.has(body[end] as number)) end--;
  if (body[end] !== 0x7d) return body;
  let start = end - 1;
  while (start >= 0 && WS.has(body[start] as number)) start--;
  const empty = body[start] === 0x7b;
  return Buffer.concat([
    body.subarray(0, end),
    Buffer.from(`${empty ? "" : ","}"stream_options":{"include_usage":true}}`),
  ]);
}
