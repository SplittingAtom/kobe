import { describe, expect, it } from "vitest";
import { mirrorTagName, registryVersionMirrorSchema } from "./skill-mirror.js";

describe("skill mirror contract (KOBE-343)", () => {
  it("names tags <name>/v<semver>", () => {
    expect(mirrorTagName("quarterly-report", "1.3.0")).toBe("quarterly-report/v1.3.0");
  });

  it("parses a pushed and a failed version, and refuses unknown fields", () => {
    const at = "2026-10-22T10:00:00.000Z";
    expect(
      registryVersionMirrorSchema.safeParse({
        url: "https://git.example.org/c.git",
        status: "pushed",
        commit: "a".repeat(40),
        tag: "x/v1.0.0",
        tree: "b".repeat(40),
        pushedAt: at,
        attempts: 0,
        lastAttemptAt: at,
      }).success,
    ).toBe(true);
    expect(
      registryVersionMirrorSchema.safeParse({
        url: "https://git.example.org/c.git",
        status: "failed",
        attempts: 2,
        lastError: "egress proxy refused",
        lastAttemptAt: at,
        nextAttemptAt: at,
      }).success,
    ).toBe(true);
    expect(
      registryVersionMirrorSchema.safeParse({
        url: "u",
        status: "pushed",
        attempts: 0,
        lastAttemptAt: at,
        token: "x",
      }).success,
    ).toBe(false);
  });
});
