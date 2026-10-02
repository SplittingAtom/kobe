import { describe, expect, it } from "vitest";
import { statusMessage } from "./kube.js";

describe("statusMessage", () => {
  const denied =
    "namespaces \"kobe-admission-probe\" is forbidden: ValidatingAdmissionPolicy 'x' denied request: Kobe may only manage kobe-team-* namespaces, not kobe-admission-probe";

  it("reads the message of a Status sent as raw JSON text (client-node v2)", () => {
    expect(
      statusMessage(
        JSON.stringify({ kind: "Status", status: "Failure", message: denied, code: 403 }),
      ),
    ).toBe(denied);
  });

  it("reads a parsed Status, and falls back to plain text or undefined", () => {
    expect(statusMessage({ message: "x" })).toBe("x");
    expect(statusMessage("upstream connect error")).toBe("upstream connect error");
    expect(statusMessage(undefined)).toBeUndefined();
    expect(statusMessage("")).toBeUndefined();
  });
});
