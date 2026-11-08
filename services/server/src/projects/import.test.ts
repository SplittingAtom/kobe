import { describe, expect, it } from "vitest";
import { mimeForName } from "./import.js";

describe("mimeForName (KOBE-585)", () => {
  it("declares a type from the extension; the bytes' signature still wins later", () => {
    expect(mimeForName("plan.md")).toBe("text/markdown");
    expect(mimeForName("sales.CSV")).toBe("text/csv");
    expect(mimeForName("load.py")).toBe("text/x-python");
    expect(mimeForName("report.docx")).toBe("application/octet-stream");
    expect(mimeForName("README")).toBe("application/octet-stream");
    expect(mimeForName(".env")).toBe("application/octet-stream");
  });
});
