import { describe, expect, it } from "vitest";
import { decodeActivityCursor, encodeActivityCursor } from "./cursor.js";

const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";

describe("activity cursor", () => {
  it("round-trips microsecond positions", () => {
    const cursor = encodeActivityCursor({ micros: "1759370000123456", id: ID });
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeActivityCursor(cursor)).toEqual({ micros: "1759370000123456", id: ID });
  });

  it.each([
    ["garbage", "not a cursor!"],
    ["empty", ""],
    ["bad json", Buffer.from("{").toString("base64url")],
    ["missing id", Buffer.from(JSON.stringify({ a: "1" })).toString("base64url")],
    ["bad id", Buffer.from(JSON.stringify({ a: "1", i: "x" })).toString("base64url")],
    ["float micros", Buffer.from(JSON.stringify({ a: "1.5", i: ID })).toString("base64url")],
    ["negative", Buffer.from(JSON.stringify({ a: "-1", i: ID })).toString("base64url")],
    ["overflow", Buffer.from(JSON.stringify({ a: "9".repeat(18), i: ID })).toString("base64url")],
    ["extra keys", Buffer.from(JSON.stringify({ a: "1", i: ID, x: 1 })).toString("base64url")],
    ["too long", "A".repeat(600)],
  ])("rejects %s", (_name, cursor) => {
    expect(decodeActivityCursor(cursor)).toBeNull();
  });
});
