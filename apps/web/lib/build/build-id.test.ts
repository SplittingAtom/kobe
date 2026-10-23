import { describe, expect, it } from "vitest";
import { CLIENT_BUILD_ID, DEV_BUILD_ID, resolveBuildId } from "./build-id";

/** KOBE-487 ac-1: every web build carries an id, from the image build or a fresh random one. */
describe("resolveBuildId", () => {
  it("takes the id the image build passed in", () => {
    expect(resolveBuildId({ KOBE_BUILD_ID: "local-1e6fff80abcd" })).toBe("local-1e6fff80abcd");
  });

  it("makes a new id per build when none was passed", () => {
    const a = resolveBuildId({});
    const b = resolveBuildId({ KOBE_BUILD_ID: "  " });
    expect(a).toMatch(/^[a-z0-9]+-[0-9a-f]{8}$/);
    expect(b).not.toBe(a);
  });

  it("refuses an id that is not a short token", () => {
    expect(() => resolveBuildId({ KOBE_BUILD_ID: "<script>" })).toThrow(/KOBE_BUILD_ID/);
    expect(() => resolveBuildId({ KOBE_BUILD_ID: "x".repeat(65) })).toThrow(/KOBE_BUILD_ID/);
  });

  it("is the dev id where the build inlined none (tests, a bare next dev)", () => {
    expect(CLIENT_BUILD_ID).toBe(DEV_BUILD_ID);
  });
});
