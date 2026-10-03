import { describe, expect, it } from "vitest";
import { applyMergePatch } from "../testing/fake-kube.js";
import { replacingPatch } from "./merge-patch.js";

describe("replacingPatch", () => {
  const current = {
    runtimeClassName: "gvisor-old",
    hostAliases: [{ ip: "10.0.0.1", hostnames: ["server.kobe.internal"] }],
    securityContext: { runAsUser: 1000, fsGroup: 1000, legacy: true },
    removedField: "x",
  };
  const next = {
    runtimeClassName: "gvisor",
    hostAliases: [{ ip: "10.0.0.2", hostnames: ["server.kobe.internal"] }],
    securityContext: { runAsUser: 1000, fsGroup: 1000 },
    dnsPolicy: "None",
  };

  it("turns the current value into exactly the next one when merge-patched", () => {
    expect(applyMergePatch(current, replacingPatch(current, next))).toEqual(next);
  });

  it("nulls keys that disappeared, at every level, and replaces arrays", () => {
    expect(replacingPatch(current, next)).toEqual({
      removedField: null,
      runtimeClassName: "gvisor",
      hostAliases: next.hostAliases,
      securityContext: { legacy: null, runAsUser: 1000, fsGroup: 1000 },
      dnsPolicy: "None",
    });
  });

  it("replaces non-object values outright", () => {
    expect(replacingPatch(undefined, { a: 1 })).toEqual({ a: 1 });
    expect(replacingPatch({ a: 1 }, [1, 2])).toEqual([1, 2]);
  });
});
