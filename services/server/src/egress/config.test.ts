import { describe, expect, it } from "vitest";
import { loadEgressHeaderSecrets } from "./config.js";

describe("egress header secret config", () => {
  it("is off when unset", () => {
    expect(loadEgressHeaderSecrets({})).toBeUndefined();
  });

  it("returns the current secret first, then the previous one", () => {
    const current = "c".repeat(40);
    const previous = "p".repeat(40);
    expect(loadEgressHeaderSecrets({ KOBE_EGRESS_HEADER_SECRET: current })).toEqual([current]);
    expect(
      loadEgressHeaderSecrets({
        KOBE_EGRESS_HEADER_SECRET: current,
        KOBE_EGRESS_HEADER_SECRET_PREVIOUS: previous,
      }),
    ).toEqual([current, previous]);
  });

  it("fails fast on a short secret or a previous one alone, without echoing values", () => {
    expect(() => loadEgressHeaderSecrets({ KOBE_EGRESS_HEADER_SECRET: "short-secret" })).toThrow(
      /at least 32 characters/,
    );
    expect(() =>
      loadEgressHeaderSecrets({ KOBE_EGRESS_HEADER_SECRET: "short-secret" }),
    ).not.toThrow(/short-secret/);
    expect(() =>
      loadEgressHeaderSecrets({ KOBE_EGRESS_HEADER_SECRET_PREVIOUS: "p".repeat(40) }),
    ).toThrow(/needs KOBE_EGRESS_HEADER_SECRET/);
  });
});
