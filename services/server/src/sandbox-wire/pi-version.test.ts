import { PI_PINNED_VERSION } from "@kobe/protocol";
import { describe, expect, it } from "vitest";
import { admitPiVersion, supportedPiVersion } from "./connection.js";

/** KOBE-511: the server accepts the pinned Pi's minor and the previous image's 1.0.x only. */
describe("supportedPiVersion", () => {
  it("pins Pi 1.4.0", () => {
    expect(PI_PINNED_VERSION).toBe("1.4.0");
  });

  it("accepts any patch of the pinned minor and of 1.0", () => {
    for (const version of ["1.4.0", "1.4.12", "1.0.0", "1.0.4"]) {
      expect(supportedPiVersion(version), version).toBe(true);
    }
  });

  it("refuses other minors, majors, pre-releases and junk", () => {
    for (const version of [
      "1.1.0",
      "1.3.0",
      "1.5.0",
      "2.0.0",
      "0.99.2",
      "1.4.0-rc.1",
      "1.4",
      "x",
    ]) {
      expect(supportedPiVersion(version), version).toBe(false);
    }
  });
});

describe("admitPiVersion (the hello's gate)", () => {
  const recorder = () => {
    const warnings: { obj: Record<string, unknown>; msg: string }[] = [];
    return {
      warnings,
      log: {
        warn: (obj: Record<string, unknown>, msg: string) => void warnings.push({ obj, msg }),
      },
    };
  };

  it("accepts a 1.0.x hello and logs a warning naming the sandbox and the version", () => {
    const { warnings, log } = recorder();
    expect(admitPiVersion("1.0.0", log, "sb-1")).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.obj).toMatchObject({ sandbox_id: "sb-1", pi_version: "1.0.0" });
    expect(warnings[0]?.msg).toContain("KOBE-518");
  });

  it("accepts a 1.4.x hello without logging", () => {
    const { warnings, log } = recorder();
    expect(admitPiVersion("1.4.0", log, "sb-1")).toBe(true);
    expect(admitPiVersion("1.4.3", log, "sb-1")).toBe(true);
    expect(warnings).toHaveLength(0);
  });

  it("refuses an unsupported version without logging", () => {
    const { warnings, log } = recorder();
    expect(admitPiVersion("2.0.0", log, "sb-1")).toBe(false);
    expect(warnings).toHaveLength(0);
  });
});
