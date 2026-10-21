import { describe, expect, it } from "vitest";
import { textOf } from "./viewing.js";

describe("viewed-file text (KOBE-462)", () => {
  it("keeps UTF-8 text and refuses binary", () => {
    expect(textOf(Buffer.from("héllo\n"), false)).toBe("héllo\n");
    expect(textOf(Buffer.from([0x68, 0x00, 0x69]), false)).toBeUndefined();
    expect(textOf(Buffer.from([0xff, 0xfe, 0x41]), false)).toBeUndefined();
  });

  it("drops a character the cut split, only when the file goes on", () => {
    const euro = Buffer.from("a€"); // 61 e2 82 ac
    expect(textOf(euro.subarray(0, 3), true)).toBe("a");
    expect(textOf(euro.subarray(0, 3), false)).toBeUndefined();
    expect(textOf(euro, true)).toBe("a€");
  });
});
