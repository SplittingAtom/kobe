/**
 * The top-level `"model"` of a JSON request body (KOBE-40 review): scanned structurally (strings,
 * escapes and nesting tracked) so a `"model"` inside a message or a nested object never counts,
 * and without building the whole object (bodies may be megabytes of images). The body must be a
 * JSON object; a duplicated top-level `model` is refused (JSON parsers disagree on which wins).
 */
export type BodyModel =
  | { readonly ok: true; readonly model: string | undefined }
  | { readonly ok: false; readonly reason: "not_json_object" | "duplicate_model" | "bad_model" };

const WS = new Set([0x20, 0x09, 0x0a, 0x0d]);
const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const MAX_MODEL = 200;

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

  try {
    ws();
    expect(0x7b);
    ws();
    let model: string | undefined;
    let seen = false;
    if (body[i] === 0x7d) {
      i++;
    } else {
      for (;;) {
        ws();
        const [ks, ke] = string();
        const isModel = ke - ks <= 16 && decode(ks, ke) === "model";
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
    return { ok: true, model };
  } catch (err) {
    if (err instanceof Malformed || err instanceof SyntaxError) {
      return { ok: false, reason: "not_json_object" };
    }
    throw err;
  }
}
