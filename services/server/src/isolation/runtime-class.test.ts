import { describe, expect, it } from "vitest";
import {
  ISOLATION_REMEDIATION,
  checkIsolation,
  findIsolationRuntimeClasses,
  isIsolationHandler,
} from "./runtime-class.js";

const rc = (name: string, handler: string) => ({ metadata: { name }, handler });

describe("isIsolationHandler", () => {
  it.each(["runsc", "kata", "kata-qemu", "kata-clh", "kata-fc", "kata-qemu-snp", "kata-clh-tdx"])(
    "accepts %s",
    (h) => {
      expect(isIsolationHandler(h)).toBe(true);
    },
  );

  it.each([
    "runc",
    "crun",
    "nvidia",
    "wasmtime",
    "runsc-debug",
    "runsc2",
    "Runsc",
    "runsc ",
    " runsc",
    "katana",
    "kataX",
    "kata-",
    "kata--qemu",
    "kata-qemu-",
    "kata-QEMU",
    "",
  ])("rejects %s", (h) => {
    expect(isIsolationHandler(h)).toBe(false);
  });
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

describe("checkIsolation for the configured RuntimeClass", () => {
  const cluster = async () => [rc("gvisor", "runsc"), rc("runc", "runc"), rc("kata", "kata-qemu")];

  it("passes when the configured RuntimeClass has an isolation handler", async () => {
    expect(await checkIsolation(cluster, "kata")).toEqual({
      ok: true,
      runtimeClasses: [{ name: "kata", handler: "kata-qemu" }],
    });
  });

  it("fails when the configured RuntimeClass is not isolating, even if another one is", async () => {
    const result = await checkIsolation(cluster, "runc");
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toMatch(/RuntimeClass "runc" has handler "runc"/);
  });

  it("fails when the configured RuntimeClass does not exist", async () => {
    const result = await checkIsolation(cluster, "gvisor-typo");
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toMatch(/RuntimeClass "gvisor-typo" does not exist/);
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
