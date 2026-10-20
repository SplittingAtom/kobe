import { describe, expect, it } from "vitest";
import { visibleParts } from "./visible-text";

describe("visibleParts (KOBE-334 review L4)", () => {
  it("shows bidi overrides and zero-width characters as markers", () => {
    expect(visibleParts("a\u202Eb\u200Bc")).toEqual([
      { text: "a", hidden: false },
      { text: "⟨U+202E⟩", hidden: true },
      { text: "b", hidden: false },
      { text: "⟨U+200B⟩", hidden: true },
      { text: "c", hidden: false },
    ]);
    expect(visibleParts("plain")).toEqual([{ text: "plain", hidden: false }]);
    expect(visibleParts("tag\u{E0041}")).toEqual([
      { text: "tag", hidden: false },
      { text: "⟨U+E0041⟩", hidden: true },
    ]);
  });
});
