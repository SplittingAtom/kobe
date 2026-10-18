import { describe, expect, it, vi } from "vitest";
import { createOffboarding } from "./index.js";
import { purgeDeparted } from "./purge.js";

/** KOBE-243: with KOBE_RETENTION_PAUSED nothing is judged or deleted (no db, provider or bucket is touched). */
const boom = new Proxy({}, { get: () => () => Promise.reject(new Error("must not be touched")) });
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

describe("paused offboarding", () => {
  it("the sweep does nothing", async () => {
    const off = createOffboarding({ db: boom as never, blobs: undefined, log, paused: true });
    expect(await off.sweep()).toEqual({ offboarded: 0, purged: 0, held: 0, drafts: 0, failed: 0 });
  });

  it("the purge deletes nothing", async () => {
    const delVolume = vi.fn();
    const del = vi.fn();
    const outcome = await purgeDeparted(
      {
        db: boom as never,
        blobs: { prefix: "", objects: { delete: del } as never },
        log,
        paused: true,
        provider: () => ({ deleteVolume: delVolume, destroySandbox: vi.fn() }) as never,
      },
      { teamId: "t", userId: "u" },
    );
    expect(outcome).toBe("unavailable");
    expect(delVolume).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
  });
});
