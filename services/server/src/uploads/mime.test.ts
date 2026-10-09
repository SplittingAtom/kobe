import { describe, expect, it } from "vitest";
import { resolveMime, sniffMime } from "./mime.js";

const bytes = (...v: number[]) => Uint8Array.from(v);
const text = (s: string) => new TextEncoder().encode(s);

describe("mime sniffing", () => {
  it("recognizes common signatures", () => {
    expect(sniffMime(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe("image/png");
    expect(sniffMime(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe("image/jpeg");
    expect(sniffMime(text("%PDF-1.7"))).toBe("application/pdf");
    expect(sniffMime(text("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp");
    expect(sniffMime(text("hello"))).toBeUndefined();
  });

  it("prefers the signature over a lying declared type", () => {
    expect(resolveMime(text("%PDF-1.7"), "text/plain")).toBe("application/pdf");
  });

  it("keeps a declared type for unknown bytes, and a specific zip-based one", () => {
    expect(resolveMime(text("a,b\n1,2"), "text/csv; charset=utf-8")).toBe("text/csv");
    const zip = bytes(0x50, 0x4b, 0x03, 0x04);
    expect(
      resolveMime(zip, "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
    ).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    expect(resolveMime(zip, "")).toBe("application/zip");
  });

  it("falls back to octet-stream and never rejects", () => {
    expect(resolveMime(text("???"), "not a type")).toBe("application/octet-stream");
    expect(resolveMime(new Uint8Array(0), undefined)).toBe("application/octet-stream");
  });
});
