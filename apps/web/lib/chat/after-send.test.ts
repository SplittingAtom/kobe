import { describe, expect, it } from "vitest";
import { textAfterSend } from "./after-send";

describe("textAfterSend (KOBE-415)", () => {
  it("clears the unchanged sent text", () => {
    expect(textAfterSend("hello", "hello")).toBe("");
  });
  it("keeps only what was typed after it, without the joining space or line break", () => {
    expect(textAfterSend("hello world", "hello")).toBe("world");
    expect(textAfterSend("hello\nworld", "hello")).toBe("world");
    expect(textAfterSend("hello  two", "hello")).toBe(" two");
    expect(textAfterSend("hello!", "hello")).toBe("!");
  });
  it("keeps everything when the sent part was edited or replaced", () => {
    expect(textAfterSend("help world", "hello")).toBe("help world");
    expect(textAfterSend("BRAVO", "ALPHA")).toBe("BRAVO");
    expect(textAfterSend("", "hello")).toBe("");
  });
});
