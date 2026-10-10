import { describe, expect, it, vi } from "vitest";
import { SandboxWakeError } from "../sandbox-wire/types.js";
import { ensureReady, WORKSPACE_UNAVAILABLE_MESSAGE, type ReadyProvider } from "./ready.js";

const stall = {
  cause: "volume_unschedulable",
  detail: "FailedAttachVolume: insufficient storage on node compute2",
  definite: true,
} as const;
const log = { warn: vi.fn(), error: vi.fn() } as never;
const TEAM = { id: "t", slug: "finance" };

function run(awaitReady: ReadyProvider["awaitReady"]) {
  const onStalled = vi.fn(async () => {});
  const result = ensureReady({
    provider: { awaitReady },
    team: TEAM,
    userId: "u",
    since: 123,
    log,
    onStalled,
  });
  return { result, onStalled, awaitReady };
}

describe("ensureReady", () => {
  it("does nothing more for a Ready sandbox", async () => {
    const r = run(vi.fn(async () => ({ ready: true as const })));
    await expect(r.result).resolves.toBeUndefined();
    expect(r.onStalled).not.toHaveBeenCalled();
    expect(r.awaitReady).toHaveBeenCalledWith(TEAM, "u", 123);
  });

  it("fails with a member-safe error and tells admins the reason", async () => {
    const r = run(async () => ({ ready: false, sandboxId: "sb-1", stall }));
    const err = await r.result.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SandboxWakeError);
    expect(err).toMatchObject({
      code: "workspace_unavailable",
      message: WORKSPACE_UNAVAILABLE_MESSAGE,
    });
    expect((err as Error).message).not.toMatch(/compute2|volume|storage on node/);
    expect(r.onStalled).toHaveBeenCalledWith({ sandboxId: "sb-1", stall });
  });
});
