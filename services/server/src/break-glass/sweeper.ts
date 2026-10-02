import type { ServerDeps } from "../deps.js";
import { logger } from "../logger.js";
import { deliverBreakGlassNotifications } from "./outbox.js";
import { expireDueGrants } from "./store.js";

/** How often each replica records ended grants and retries notifications. Access itself ends at `expires_at`, not here. */
export const BREAK_GLASS_SWEEP_INTERVAL_MS = 60_000;

/**
 * Records `governance.break_glass.expired` for grants whose window ended (and requests that lapsed
 * undecided), then delivers every due notification, including retries of earlier failures (D10:
 * auto-expiring, notified). Runs on every replica; rows are claimed with SKIP LOCKED, so each
 * expiry is recorded once and each email sent once.
 */
export async function sweepBreakGlass(deps: ServerDeps): Promise<number> {
  const expired = await expireDueGrants(deps.database.db);
  await deliverBreakGlassNotifications(deps);
  return expired.length;
}

export class BreakGlassSweeper {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;

  constructor(private readonly deps: ServerDeps) {}

  start(): void {
    const run = () => {
      if (this.running) return;
      this.running = true;
      sweepBreakGlass(this.deps)
        .catch((err: unknown) => logger.error({ err }, "break-glass expiry sweep failed"))
        .finally(() => {
          this.running = false;
        });
    };
    run();
    this.timer ??= setInterval(run, BREAK_GLASS_SWEEP_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
