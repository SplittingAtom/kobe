import { describe, expect, it } from "vitest";
import { DOMAIN_PATTERN_SQL } from "../schema/egress.js";
import {
  findMatchingPattern,
  normalizeHost,
  parseDomainPattern,
  patternMatches,
} from "./domain.js";

describe("normalizeHost", () => {
  it("lowercases, strips one trailing dot and converts IDNA", () => {
    expect(normalizeHost("PyPI.org")).toBe("pypi.org");
    expect(normalizeHost("pypi.org.")).toBe("pypi.org");
    expect(normalizeHost("bücher.example")).toBe("xn--bcher-kva.example");
  });

  it("refuses IP literals, single labels, empties and junk", () => {
    for (const bad of [
      "",
      "127.0.0.1",
      "::1",
      "[::1]",
      "0x7f.1",
      "localhost",
      "a..b",
      "-a.com",
      "a.com:443",
      "a b.com",
      "a.123",
      `${"a".repeat(64)}.com`,
      `${"a.".repeat(130)}com`,
      "*.example.com",
    ]) {
      expect(normalizeHost(bad), bad).toBeNull();
    }
  });
});

describe("parseDomainPattern", () => {
  it("accepts hosts and leading wildcards, canonicalized", () => {
    expect(parseDomainPattern(" PyPI.org ")).toEqual({ ok: true, pattern: "pypi.org" });
    expect(parseDomainPattern("*.GitHub.com")).toEqual({ ok: true, pattern: "*.github.com" });
  });

  it("refuses wildcards elsewhere, URLs, ports, IPs and bare TLD wildcards", () => {
    for (const bad of [
      "a.*.com",
      "*",
      "*.com",
      "https://pypi.org",
      "pypi.org:443",
      "10.0.0.1",
      "**.a.com",
      "u@a.com",
    ]) {
      expect(parseDomainPattern(bad).ok, bad).toBe(false);
    }
  });

  it("agrees with the database CHECK grammar", () => {
    const re = new RegExp(DOMAIN_PATTERN_SQL);
    for (const p of ["pypi.org", "*.github.com", "xn--bcher-kva.example", "a-b.c-d.io"]) {
      const parsed = parseDomainPattern(p);
      expect(parsed.ok && re.test(parsed.pattern), p).toBe(true);
    }
    for (const p of ["*.com", "a.*.com", "10.0.0.1", "A.com", "pypi.org."]) {
      expect(re.test(p), p).toBe(false);
    }
  });
});

describe("matching", () => {
  it("exact patterns match only themselves", () => {
    expect(patternMatches("pypi.org", "pypi.org")).toBe(true);
    expect(patternMatches("pypi.org", "evil-pypi.org")).toBe(false);
    expect(patternMatches("pypi.org", "x.pypi.org")).toBe(false);
  });

  it("wildcards match subdomains at any depth, never the apex or look-alikes", () => {
    expect(patternMatches("*.github.com", "api.github.com")).toBe(true);
    expect(patternMatches("*.github.com", "a.b.github.com")).toBe(true);
    expect(patternMatches("*.github.com", "github.com")).toBe(false);
    expect(patternMatches("*.github.com", "evilgithub.com")).toBe(false);
  });

  it("findMatchingPattern prefers the exact name, then the closest wildcard", () => {
    const set = new Set(["a.b.example.com", "*.b.example.com", "*.example.com"]);
    expect(findMatchingPattern(set, "a.b.example.com")).toBe("a.b.example.com");
    expect(findMatchingPattern(set, "c.b.example.com")).toBe("*.b.example.com");
    expect(findMatchingPattern(set, "x.example.com")).toBe("*.example.com");
    expect(findMatchingPattern(set, "example.com")).toBeUndefined();
    expect(findMatchingPattern(set, "example.org")).toBeUndefined();
  });
});
