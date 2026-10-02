import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ISOLATION_MAX_AGE_MS,
  ISOLATION_RECHECK_INTERVAL_MS,
  IsolationRuntimeMissingError,
  createIsolationGate,
  type IsolationGateOptions,
  type IsolationStatus,
} from "./gate.js";
import type { RuntimeClassLike } from "./runtime-class.js";

const rc = (name: string, handler: string): RuntimeClassLike => ({ metadata: { name }, handler });
const GVISOR = [rc("gvisor", "runsc"), rc("runc", "runc")];

function gate(overrides: Partial<IsolationGateOptions> = {}) {
  let clock = new Date("2026-10-02T00:00:00Z");
  const g = createIsolationGate({
    runtimeClassName: "gvisor",
    listRuntimeClasses: async () => GVISOR,
    now: () => clock,
    ...overrides,
  });
  return { g, advance: (ms: number) => (clock = new Date(clock.getTime() + ms)) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("isolation gate: startup check", () => {
  it("is 'checking' until the first check completes", () => {
    const { g } = gate();
    expect(g.status()).toEqual({ state: "checking", runtimeClassName: "gvisor" });
  });

  it("verifies the configured RuntimeClass by its handler", async () => {
    const { g } = gate();
    const status = await g.start();
    g.stop();
    expect(status).toEqual({
      state: "verified",
      runtimeClassName: "gvisor",
      handler: "runsc",
      checkedAt: new Date("2026-10-02T00:00:00Z"),
    });
    expect(g.status()).toEqual(status);
  });

  it("refuses a class named like gVisor whose handler is not isolating", async () => {
    const { g } = gate({ listRuntimeClasses: async () => [rc("gvisor", "runc")] });
    const status = await g.check();
    expect(status.state).toBe("missing");
    expect(status.state === "missing" && status.message).toMatch(/handler "runc"/);
  });

  it("refuses a missing RuntimeClass with remediation text", async () => {
    const { g } = gate({ listRuntimeClasses: async () => [rc("runc", "runc")] });
    const status = await g.check();
    expect(status.state === "missing" && status.message).toMatch(/does not exist.*install-gvisor/);
  });

  it("is permanently missing when KOBE_RUNTIME_CLASS is not set, without calling the API", async () => {
    const list = vi.fn(async () => GVISOR);
    const { g } = gate({ runtimeClassName: undefined, listRuntimeClasses: list });
    expect(g.status().state).toBe("missing");
    const status = await g.check();
    expect(status.state === "missing" && status.message).toMatch(/KOBE_RUNTIME_CLASS is not set/);
    expect(list).not.toHaveBeenCalled();
    await expect(g.require()).rejects.toBeInstanceOf(IsolationRuntimeMissingError);
  });

  it("reports an unset KOBE_RUNTIME_CLASS once, for the operator log", async () => {
    const onChange = vi.fn();
    const { g } = gate({ runtimeClassName: undefined, onChange });
    await g.start();
    await g.check();
    g.stop();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]?.[0]).toMatchObject({ state: "missing" });
  });

  it("fails closed when the Kubernetes API errors", async () => {
    const { g } = gate({
      listRuntimeClasses: async () => {
        throw new Error("forbidden");
      },
    });
    const status = await g.check();
    expect(status.state === "missing" && status.message).toMatch(/forbidden/);
  });

  it("fails closed when the Kubernetes API hangs", async () => {
    vi.useFakeTimers();
    const { g } = gate({ listRuntimeClasses: () => new Promise(() => {}), apiTimeoutMs: 1_000 });
    const pending = g.check();
    await vi.advanceTimersByTimeAsync(1_000);
    const status = await pending;
    expect(status.state === "missing" && status.message).toMatch(/timed out/);
  });

  it("deduplicates concurrent checks", async () => {
    const list = vi.fn(async () => GVISOR);
    const { g } = gate({ listRuntimeClasses: list });
    await Promise.all([g.check(), g.check(), g.require()]);
    expect(list).toHaveBeenCalledTimes(1);
  });
});

describe("isolation gate: require() before agent work", () => {
  it("returns the verified RuntimeClass sandboxes must use", async () => {
    const { g } = gate();
    await g.check();
    await expect(g.require()).resolves.toEqual({ runtimeClassName: "gvisor", handler: "runsc" });
  });

  it("waits for the first check instead of failing or passing early", async () => {
    const { g } = gate();
    await expect(g.require()).resolves.toEqual({ runtimeClassName: "gvisor", handler: "runsc" });
  });

  it("throws isolation_runtime_missing (HTTP 503) when isolation is missing", async () => {
    const { g } = gate({ listRuntimeClasses: async () => [] });
    const err = await g.require().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IsolationRuntimeMissingError);
    expect(err).toMatchObject({ code: "isolation_runtime_missing", status: 503 });
    expect((err as IsolationRuntimeMissingError).toResponseBody()).toEqual({
      code: "isolation_runtime_missing",
      message: expect.stringMatching(/isolation runtime missing/i),
    });
  });

  it("re-checks a stale verification before trusting it", async () => {
    let classes = GVISOR;
    const list = vi.fn(async () => classes);
    const { g, advance } = gate({ listRuntimeClasses: list });
    await g.check();
    classes = [rc("gvisor", "runc")]; // replaced after boot
    advance(ISOLATION_MAX_AGE_MS - 1);
    await expect(g.require()).resolves.toMatchObject({ runtimeClassName: "gvisor" });
    advance(2);
    await expect(g.require()).rejects.toBeInstanceOf(IsolationRuntimeMissingError);
    expect(list).toHaveBeenCalledTimes(2);
    expect(g.status().state).toBe("missing");
  });
});

describe("isolation gate: periodic re-check", () => {
  it("disables agents when the RuntimeClass disappears after boot, and recovers", async () => {
    vi.useFakeTimers();
    let classes: readonly RuntimeClassLike[] = GVISOR;
    const changes: IsolationStatus["state"][] = [];
    const g = createIsolationGate({
      runtimeClassName: "gvisor",
      listRuntimeClasses: async () => classes,
      onChange: (s) => changes.push(s.state),
    });
    await g.start();
    expect(g.status().state).toBe("verified");

    classes = [];
    await vi.advanceTimersByTimeAsync(ISOLATION_RECHECK_INTERVAL_MS);
    expect(g.status().state).toBe("missing");
    await expect(g.require()).rejects.toBeInstanceOf(IsolationRuntimeMissingError);

    classes = GVISOR;
    await vi.advanceTimersByTimeAsync(ISOLATION_RECHECK_INTERVAL_MS);
    expect(g.status().state).toBe("verified");

    // A steady state does not report again (one log line per transition).
    await vi.advanceTimersByTimeAsync(ISOLATION_RECHECK_INTERVAL_MS * 3);
    expect(changes).toEqual(["verified", "missing", "verified"]);
    g.stop();
  });

  it("stops re-checking after stop()", async () => {
    vi.useFakeTimers();
    const list = vi.fn(async () => GVISOR);
    const g = createIsolationGate({ runtimeClassName: "gvisor", listRuntimeClasses: list });
    await g.start();
    g.stop();
    await vi.advanceTimersByTimeAsync(ISOLATION_RECHECK_INTERVAL_MS * 3);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("keeps the recheck interval shorter than the max age", () => {
    expect(ISOLATION_RECHECK_INTERVAL_MS).toBeLessThan(ISOLATION_MAX_AGE_MS);
  });
});
