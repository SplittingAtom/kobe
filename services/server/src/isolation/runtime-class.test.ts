import { describe, expect, it } from "vitest";
import {
  ISOLATION_REMEDIATION,
  checkIsolation,
  findIsolationRuntimeClasses,
  isIsolationHandler,
} from "./runtime-class.js";

const rc = (name: string, handler: string) => ({ metadata: { name }, handler });

describe("isIsolationHandler", () => {
  it.each(["runsc", "kata", "kata-qemu", "kata-clh", "kata-fc"])("accepts %s", (h) => {
    expect(isIsolationHandler(h)).toBe(true);
  });

  it.each(["runc", "crun", "nvidia", "wasmtime", "runsc-debug", "katana", ""])(
    "rejects %s",
    (h) => {
      expect(isIsolationHandler(h)).toBe(false);
    },
  );
});

describe("findIsolationRuntimeClasses", () => {
  it("judges by handler, not by name", () => {
    const found = findIsolationRuntimeClasses([
      rc("gvisor", "runsc"),
      rc("runsc", "runc"), // misleadingly named: not isolation
      rc("kata", "kata-qemu"),
      rc("nvidia", "nvidia"),
    ]);
    expect(found).toEqual([
      { name: "gvisor", handler: "runsc" },
      { name: "kata", handler: "kata-qemu" },
    ]);
  });
});

describe("checkIsolation", () => {
  it("passes when an isolation RuntimeClass exists", async () => {
    const result = await checkIsolation(async () => [rc("crun", "crun"), rc("gvisor", "runsc")]);
    expect(result).toEqual({ ok: true, runtimeClasses: [{ name: "gvisor", handler: "runsc" }] });
  });

  it("fails with remediation text when none exists", async () => {
    const result = await checkIsolation(async () => [rc("crun", "crun")]);
    expect(result).toEqual({ ok: false, message: ISOLATION_REMEDIATION });
    expect(ISOLATION_REMEDIATION).toMatch(/gVisor/);
    expect(ISOLATION_REMEDIATION).toMatch(/Kata/);
    expect(ISOLATION_REMEDIATION).toMatch(/install-gvisor-k3s\.sh/);
  });

  it("fails closed when the RuntimeClass list cannot be read", async () => {
    const result = await checkIsolation(async () => {
      throw new Error("forbidden");
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toMatch(/could not list RuntimeClasses: forbidden/);
  });
});
