import { describe, expect, it } from "vitest";
import { formatKiB } from "./format";

describe("formatKiB (KOBE-501)", () => {
  it("states a size in whole KiB, rounded up so a limit is never understated", () => {
    expect(formatKiB(512 * 1024)).toBe("512 KiB");
    expect(formatKiB(256 * 1024 + 1)).toBe("257 KiB");
    expect(formatKiB(1)).toBe("1 KiB");
  });
});
