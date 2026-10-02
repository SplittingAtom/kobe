import { logger } from "../logger.js";

export type LifecycleEvent = "deactivated" | "reactivated";

/** A downstream step run when a user is (de)activated, e.g. "stop sandboxes" (KOBE-28). */
export interface LifecycleHook {
  readonly name: string;
  run(userId: string): Promise<void>;
}

/**
 * Seam for what else deactivation must do (spec D7): stop the user's sandboxes (KOBE-28), suspend
 * connector grants (KOBE-61), pause schedules (KOBE-64/65), audit (KOBE-15). Session revocation and
 * the sign-in block are done before hooks run and never depend on them. A failing hook is logged and
 * reported, never undoes the deactivation.
 */
export class UserLifecycle {
  private readonly hooks: Record<LifecycleEvent, LifecycleHook[]> = {
    deactivated: [],
    reactivated: [],
  };

  on(event: LifecycleEvent, hook: LifecycleHook): void {
    this.hooks[event] = [...this.hooks[event], hook];
  }

  /** Runs every hook for the event; returns the names of the ones that failed. */
  async emit(event: LifecycleEvent, userId: string): Promise<string[]> {
    const failed: string[] = [];
    for (const hook of this.hooks[event]) {
      try {
        await hook.run(userId);
      } catch (err) {
        logger.error({ err, userId, hook: hook.name, event }, "user lifecycle hook failed");
        failed.push(hook.name);
      }
    }
    return failed;
  }
}
