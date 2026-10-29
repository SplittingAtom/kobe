import { PI_PINNED_VERSION } from "@kobe/protocol";
import { describe, expect, it } from "vitest";
import { supportedPiVersion } from "./connection.js";

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
