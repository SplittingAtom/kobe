import { describe, expect, it, vi } from "vitest";
import { SandboxWakeError } from "../sandbox-wire/types.js";
import { ensureReady, WORKSPACE_UNAVAILABLE_MESSAGE, type ReadyProvider } from "./ready.js";

const stall = {
  cause: "volume_unschedulable",
  detail: "FailedAttachVolume: insufficient storage on node compute2",
  neverRan: true,
} as const;
const stalled = { ready: false, sandboxId: "sb-1", stall } as const;
const log = { warn: vi.fn(), error: vi.fn() } as never;
const TEAM = { id: "t", slug: "finance" };

function run(
  awaitReady: ReadyProvider["awaitReady"],
  retry: "retried" | "declined",
  neverStarted: boolean,
) {
  const retryStalledVolume = vi.fn(async () => retry);
  const onStalled = vi.fn(async () => {});
  const onRetried = vi.fn(async () => {});
  const result = ensureReady({
    provider: { awaitReady, retryStalledVolume },
    team: TEAM,
    userId: "u",
    neverStarted,
    log,
    onStalled,
    onRetried,
  });
  return { result, retryStalledVolume, onStalled, onRetried };
}

describe("ensureReady", () => {
  it("does nothing more for a Ready sandbox", async () => {
    const r = run(async () => ({ ready: true }), "declined", true);
    await expect(r.result).resolves.toBeUndefined();
    expect(r.retryStalledVolume).not.toHaveBeenCalled();
    expect(r.onStalled).not.toHaveBeenCalled();
  });

  it("fails with a member-safe error and tells admins the reason", async () => {
    const r = run(async () => stalled, "declined", true);
    const err = await r.result.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SandboxWakeError);
    expect(err).toMatchObject({
      code: "workspace_unavailable",
      message: WORKSPACE_UNAVAILABLE_MESSAGE,
    });
    expect((err as Error).message).not.toMatch(/compute2|volume|storage on node/);
    expect(r.onStalled).toHaveBeenCalledWith({ sandboxId: "sb-1", stall, retried: false });
  });

  it("retries once on a never-started sandbox and succeeds if the next node works", async () => {
    const awaitReady = vi
      .fn<ReadyProvider["awaitReady"]>()
      .mockResolvedValueOnce(stalled)
      .mockResolvedValueOnce({ ready: true });
    const r = run(awaitReady, "retried", true);
    await expect(r.result).resolves.toBeUndefined();
    expect(r.onRetried).toHaveBeenCalledTimes(1);
    expect(r.onStalled).not.toHaveBeenCalled();
  });

  it("fails after the one retry, and says so", async () => {
    const r = run(async () => stalled, "retried", true);
    await expect(r.result).rejects.toMatchObject({ code: "workspace_unavailable" });
    expect(r.retryStalledVolume).toHaveBeenCalledTimes(1);
    expect(r.onStalled).toHaveBeenCalledWith(expect.objectContaining({ retried: true }));
  });

  it("never asks to retry for a sandbox that has started before", async () => {
    const r = run(async () => stalled, "retried", false);
    await expect(r.result).rejects.toBeInstanceOf(SandboxWakeError);
    expect(r.retryStalledVolume).not.toHaveBeenCalled();
    expect(r.onRetried).not.toHaveBeenCalled();
  });
});
