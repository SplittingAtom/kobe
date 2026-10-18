import { SCAN_LIMITS } from "@kobe/skill-scanner";
import { describe, expect, it } from "vitest";
import { SKILL_LIMITS } from "./limits.js";

/**
 * The upload limits and the scanner's agree (KOBE-312 review R2): every file an upload accepts is
 * read by the scanner, so none is Block for its size alone. Only a bundle with more text than the
 * scan budget is (`scan-incomplete`).
 */
describe("upload and scan limits", () => {
  it("reads every file an upload accepts", () => {
    expect(SCAN_LIMITS.maxFileBytes).toBeGreaterThanOrEqual(SKILL_LIMITS.maxFileBytes);
  });

  it("keeps the scan budget at least one maximal file", () => {
    expect(SCAN_LIMITS.maxTotalBytes).toBeGreaterThanOrEqual(SKILL_LIMITS.maxFileBytes);
  });
});
