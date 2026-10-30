import { PI_PINNED_VERSION, PI_PREVIOUS_MINORS } from "@kobe/protocol";
import { describe, expect, it } from "vitest";
import { admitPiVersion, supportedPiVersion } from "./connection.js";

/**
 * KOBE-511/518: the server accepts the pinned Pi's minor; a previous minor only while
 * PI_PREVIOUS_MINORS names it during a Pi upgrade (empty since KOBE-518: no 1.0 sandbox remains).
 */
describe("supportedPiVersion", () => {
  it("pins Pi 1.4.0 and carries no previous minor (KOBE-518)", () => {
    expect(PI_PINNED_VERSION).toBe("1.4.0");
    expect(PI_PREVIOUS_MINORS).toEqual([]);
  });

  it("accepts any patch of the pinned minor", () => {
    for (const version of ["1.4.0", "1.4.12"]) {
      expect(supportedPiVersion(version), version).toBe(true);
    }
  });

  it("refuses 1.0.x now that the allowance is gone (KOBE-518)", () => {
    for (const version of ["1.0.0", "1.0.4"]) {
      expect(supportedPiVersion(version), version).toBe(false);
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

  it("accepts a previous minor only while an upgrade names it", () => {
    expect(supportedPiVersion("1.0.4", ["1.0"])).toBe(true);
    expect(supportedPiVersion("1.1.0", ["1.0"])).toBe(false);
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

  it("refuses a 1.0.x hello without logging (KOBE-518)", () => {
    const { warnings, log } = recorder();
    expect(admitPiVersion("1.0.0", log, "sb-1")).toBe(false);
    expect(warnings).toHaveLength(0);
  });

  it("during an upgrade, accepts a named previous minor and logs a warning naming the sandbox", () => {
    const { warnings, log } = recorder();
    expect(admitPiVersion("1.0.0", log, "sb-1", ["1.0"])).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.obj).toMatchObject({ sandbox_id: "sb-1", pi_version: "1.0.0" });
    expect(warnings[0]?.msg).toContain("previous Pi minor");
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
