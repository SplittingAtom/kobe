import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { ExportTooLargeError, filesOfPackage } from "./export.js";

describe("filesOfPackage (KOBE-345 review)", () => {
  it("reads a package within the caps", () => {
    const zip = zipSync({ "SKILL.md": strToU8("# x\n"), "provenance.json": strToU8("{}") });
    expect([...filesOfPackage(zip).keys()]).toEqual(["SKILL.md"]);
  });

  it("refuses by declared size before inflating a high-ratio entry", () => {
    const bomb = zipSync(
      { "SKILL.md": strToU8("# x\n"), "big.bin": new Uint8Array(11 * 1024 * 1024) },
      {
        level: 9,
      },
    );
    expect(bomb.length).toBeLessThan(100 * 1024);
    expect(() => filesOfPackage(bomb)).toThrow(ExportTooLargeError);
  });
});
