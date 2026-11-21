import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CURSOR_MAX_LENGTH, makeCursorCodec } from "./cursor-codec.js";

const codec = makeCursorCodec(z.strictObject({ a: z.string(), i: z.number().int() }));
const raw = (text: string) => Buffer.from(text, "utf8").toString("base64url");

describe("makeCursorCodec", () => {
  it("round-trips a value as base64url JSON, key order kept", () => {
    const token = codec.encode({ a: "x", i: 3 });
    expect(token).toBe(raw('{"a":"x","i":3}'));
    expect(codec.decode(token)).toEqual({ a: "x", i: 3 });
  });

  it("returns undefined for text that is not base64url JSON", () => {
    expect(codec.decode("")).toBeUndefined();
    expect(codec.decode("garbage!")).toBeUndefined();
    expect(codec.decode(raw("{not json"))).toBeUndefined();
    expect(codec.decode(`${codec.encode({ a: "x", i: 3 })}=`)).toBeUndefined();
  });

  it("returns undefined for JSON of the wrong shape", () => {
    expect(codec.decode(raw("null"))).toBeUndefined();
    expect(codec.decode(raw("[]"))).toBeUndefined();
    expect(codec.decode(raw('{"a":1,"i":3}'))).toBeUndefined();
    expect(codec.decode(raw('{"a":"x","i":3,"extra":true}'))).toBeUndefined();
  });

  it("returns undefined for an oversized token without parsing it", () => {
    const big = codec.encode({ a: "y".repeat(CURSOR_MAX_LENGTH), i: 1 });
    expect(big.length).toBeGreaterThan(CURSOR_MAX_LENGTH);
    expect(codec.decode(big)).toBeUndefined();
    const small = makeCursorCodec(z.object({ a: z.string() }), { maxLength: 16 });
    const at = small.encode({ a: "abcd" }); // 16 characters exactly
    expect(at).toHaveLength(16);
    expect(small.decode(at)).toEqual({ a: "abcd" });
    expect(small.decode(small.encode({ a: "abcde" }))).toBeUndefined();
  });

  it("decodes through the schema's transforms", () => {
    const lower = makeCursorCodec(z.object({ i: z.string().transform((s) => s.toLowerCase()) }));
    expect(lower.decode(lower.encode({ i: "AB" }))).toEqual({ i: "ab" });
  });
});
