import { describe, expect, it } from "vitest";
import { GALLERY_DEFINITIONS, parseGalleryDefinitions } from "./definitions.js";

describe("the repo's gallery definitions", () => {
  it("all parse, with unique keys and positive generations", () => {
    expect(() => parseGalleryDefinitions(GALLERY_DEFINITIONS)).not.toThrow();
  });

  it("refuses a missing generation", () => {
    const file = "---\nname: X\n---\nx\n";
    expect(() => parseGalleryDefinitions([{ key: "x", generation: 0, file }])).toThrow(
      /generation/,
    );
  });
});
