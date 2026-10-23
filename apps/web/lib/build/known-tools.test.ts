import { describe, expect, it } from "vitest";
import { isKnownToolName } from "./known-tools";

/** KOBE-487 ac-3: the server runs only built-in and connector tools; any other name is newer. */
describe("isKnownToolName", () => {
  it("knows this build's built-in tools and every connector tool", () => {
    for (const name of ["bash", "read", "open_file", "propose_file_edit", "mcp__catalyst__query"]) {
      expect(isKnownToolName(name)).toBe(true);
    }
  });

  it("does not know a tool added after this build", () => {
    expect(isKnownToolName("brand_new_tool")).toBe(false);
    expect(isKnownToolName("toString")).toBe(false);
  });
});
