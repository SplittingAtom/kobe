import { describe, expect, it, vi } from "vitest";
import type { KobeDb, KobeTx } from "@kobe/db";
import type { ActorContext } from "@kobe/protocol";
import type { Logger } from "pino";
import { RunError } from "../runs/errors.js";
import type { SandboxRouter } from "../sandbox-wire/types.js";
import type { Viewer } from "../threads/repository.js";
import { startKernel, WakeRefusals } from "./kernel-start.js";

vi.mock("../runs/access.js", () => ({ lockOwnedThread: vi.fn(async () => ({})) }));

const ACTOR: ActorContext = {
  user_id: "u1",
  team_id: "t1",
  site_role: "user",
  team_role: "member",
};

/** KOBE-477 review: a start follows Run's rules for who may run (account active, a member). */
describe("startKernel", () => {
  it("refuses a member who may not run, before anything is woken or sent", async () => {
    const router = {
      isConnected: vi.fn(async () => true),
      wake: vi.fn(async () => undefined),
      notebookKernel: vi.fn(),
    };
    const host = {
      db: {} as KobeDb,
      router: router as unknown as SandboxRouter,
      log: { warn: vi.fn(), info: vi.fn() } as unknown as Logger,
      isolationMissing: () => false,
      threadTx: <T>(_a: ActorContext, fn: (tx: KobeTx, v: Viewer) => Promise<T>) =>
        fn({} as KobeTx, {} as Viewer),
      assertMayRun: vi.fn(async () => {
        throw new RunError("forbidden", "Your account can't run agents in this team.");
      }),
    };
    await expect(startKernel(host, new WakeRefusals(), ACTOR, "th")).rejects.toBeInstanceOf(
      RunError,
    );
    expect(host.assertMayRun).toHaveBeenCalledOnce();
    expect(router.isConnected).not.toHaveBeenCalled();
    expect(router.wake).not.toHaveBeenCalled();
    expect(router.notebookKernel).not.toHaveBeenCalled();
  });
});
