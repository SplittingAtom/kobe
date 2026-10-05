import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ISOLATION_RECHECK_INTERVAL_MS,
  IsolationRuntimeMissingError,
  VerifiedIsolation,
  createIsolationGate,
  type IsolationGateOptions,
  type IsolationStatus,
} from "./gate.js";
import * as gateModule from "./gate.js";
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

  it("deduplicates concurrent display/ops checks", async () => {
    const list = vi.fn(async () => GVISOR);
    const { g } = gate({ listRuntimeClasses: list });
    await Promise.all([g.check(), g.check()]);
    expect(list).toHaveBeenCalledTimes(1);
  });
});

describe("isolation gate: startup retry (KOBE-125)", () => {
  it("stays 'checking' through transient failures and publishes verified", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const { g } = gate({
      startupAttempts: 3,
      startupRetryDelayMs: 100,
      listRuntimeClasses: async () => {
        if (++calls < 3) throw new Error("connection reset");
        return GVISOR;
      },
    });
    const pending = g.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(g.status().state).toBe("checking");
    await vi.advanceTimersByTimeAsync(100);
    await expect(pending).resolves.toMatchObject({ state: "verified" });
    expect(calls).toBe(3);
    g.stop();
  });

  it("publishes missing once the attempts are exhausted", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const { g } = gate({
      startupAttempts: 2,
      startupRetryDelayMs: 100,
      listRuntimeClasses: async () => {
        calls++;
        return [];
      },
    });
    const pending = g.start();
    await vi.advanceTimersByTimeAsync(100);
    await expect(pending).resolves.toMatchObject({ state: "missing" });
    expect(calls).toBe(2);
    g.stop();
  });
});

describe("isolation gate: require() before agent work", () => {
  it("returns the verified RuntimeClass sandboxes must use", async () => {
    const { g } = gate();
    await g.check();
    await expect(g.require()).resolves.toMatchObject({
      runtimeClassName: "gvisor",
      handler: "runsc",
    });
  });

  it("waits for the first check instead of failing or passing early", async () => {
    const { g } = gate();
    await expect(g.require()).resolves.toMatchObject({
      runtimeClassName: "gvisor",
      handler: "runsc",
    });
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

  it("re-checks live before agent work, so a class replaced after boot is refused", async () => {
    let classes = GVISOR;
    const list = vi.fn(async () => classes);
    const { g } = gate({ listRuntimeClasses: list });
    await g.check();
    await expect(g.require()).resolves.toMatchObject({ runtimeClassName: "gvisor" });
    classes = [rc("gvisor", "runc")]; // deleted and recreated without isolation
    await expect(g.require()).rejects.toBeInstanceOf(IsolationRuntimeMissingError);
    expect(list).toHaveBeenCalledTimes(3);
    expect(g.status().state).toBe("missing");
  });
});

describe("isolation gate: require() is live and never joins an older check", () => {
  it("starts its own check instead of joining one that began before the call", async () => {
    const pending: ((v: readonly RuntimeClassLike[]) => void)[] = [];
    const list = vi.fn(
      () => new Promise<readonly RuntimeClassLike[]>((resolve) => pending.push(resolve)),
    );
    const { g } = gate({ listRuntimeClasses: list });
    const early = g.check(); // started before the class was replaced
    const required = g.require();
    expect(list).toHaveBeenCalledTimes(2);
    pending[1]?.([rc("gvisor", "runc")]); // what require() sees: replaced, not isolating
    await expect(required).rejects.toBeInstanceOf(IsolationRuntimeMissingError);
    pending[0]?.(GVISOR); // the older check finishes last with a stale "verified"
    await expect(early).resolves.toMatchObject({ state: "verified" });
    // An older-started check never overwrites a newer result.
    expect(g.status().state).toBe("missing");
  });
});

describe("VerifiedIsolation cannot be forged", () => {
  const forged = { runtimeClassName: "gvisor", handler: "runsc" };

  it("is returned by require() and passes the runtime guard", async () => {
    const { g } = gate();
    const verified = await g.require();
    expect(verified).toBeInstanceOf(VerifiedIsolation);
    expect(() => VerifiedIsolation.assert(verified)).not.toThrow();
    expect(Object.isFrozen(verified)).toBe(true);
  });

  it("is nominal: a structurally identical object is not assignable", () => {
    // @ts-expect-error -- missing the private #verified brand
    const typed: VerifiedIsolation = forged;
    expect(() => VerifiedIsolation.assert(typed)).toThrow(TypeError);
  });

  it("cannot be constructed outside gate.ts", () => {
    // @ts-expect-error -- the constructor is private
    expect(() => new VerifiedIsolation(Symbol("guess"), "gvisor", "runsc")).toThrow(TypeError);
    const viaPrototype: unknown = Object.create(VerifiedIsolation.prototype);
    expect(() => VerifiedIsolation.assert(viaPrototype)).toThrow(TypeError);
  });

  it("does not export its mint or token", () => {
    const exported = Object.values(gateModule);
    expect(exported.filter((v) => typeof v === "symbol")).toEqual([]);
    const mintKeys = Object.getOwnPropertySymbols(VerifiedIsolation);
    expect(mintKeys).toHaveLength(1);
    expect(exported).not.toContain(mintKeys[0]);
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

  it("keeps re-checking even when the first check's listener throws", async () => {
    vi.useFakeTimers();
    const list = vi.fn(async () => GVISOR);
    const g = createIsolationGate({
      runtimeClassName: "gvisor",
      listRuntimeClasses: list,
      onChange: () => {
        throw new Error("logger down");
      },
    });
    await expect(g.start()).resolves.toMatchObject({ state: "verified" });
    await vi.advanceTimersByTimeAsync(ISOLATION_RECHECK_INTERVAL_MS * 2);
    expect(list).toHaveBeenCalledTimes(3);
    g.stop();
  });

  it("fails closed if the clock throws mid-check, without an unhandled rejection", async () => {
    let calls = 0;
    const g = createIsolationGate({
      runtimeClassName: "gvisor",
      listRuntimeClasses: async () => GVISOR,
      now: () => {
        calls += 1;
        if (calls === 1) throw new Error("clock broke");
        return new Date(0);
      },
    });
    await expect(g.require()).rejects.toThrow(/clock broke/);
    expect(g.status()).toMatchObject({ state: "missing", runtimeClassName: "gvisor" });
  });
});
