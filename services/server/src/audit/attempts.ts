import { SYSTEM_ACTOR, type KobeDb } from "@kobe/db";
import { currentAuditContext } from "./context.js";
import { recordAuditAfter } from "./record.js";

/** Unauthenticated auth events, which anyone can cause in any number. */
export type AttemptAction =
  "auth.sign_in.failed" | "auth.sign_in.two_factor_required" | "auth.password.reset_requested";

type SignInMethod = "password" | "totp" | "backup_code" | "passkey" | "invitation";

export interface Attempt {
  readonly action: AttemptAction;
  /** The account the attempt named, when it named an existing one. */
  readonly userId: string | null;
  readonly method?: SignInMethod;
  /** Failure code (sign-in failures only). */
  readonly reason?: string;
}

export const ATTEMPT_WINDOW_MS = 5 * 60_000;
const FLUSH_INTERVAL_MS = 60_000;
const MAX_TRACKED_IPS = 1_000;

interface Window {
  readonly attempt: Attempt;
  readonly start: number;
  suppressed: number;
  readonly ips: Set<string>;
}

/**
 * Bounds what unauthenticated traffic can write to the append-only log (KOBE-15 review): per
 * (action, method, account-or-none) and window (5 min), the first attempt is recorded as its own
 * event with its client address, and the rest become one `auth.attempts.summarized` row (count,
 * distinct addresses, window) when the window closes. A flood from rotating addresses therefore
 * adds at most two rows per key and window; keys are bounded by the number of accounts.
 *
 * Per replica and in memory: a crash loses the open windows' counts (their first attempts are
 * already recorded); stop() flushes on shutdown. Successful and state-changing events are never
 * aggregated.
 */
export class AuthAttemptAudit {
  private readonly windows = new Map<string, Window>();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly db: KobeDb,
    private readonly options: { readonly windowMs?: number; readonly now?: () => number } = {},
  ) {}

  private get windowMs(): number {
    return this.options.windowMs ?? ATTEMPT_WINDOW_MS;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  /** Records an attempt: as its own event when it opens a window, else counted into it. */
  async record(attempt: Attempt): Promise<void> {
    const key = `${attempt.action}|${attempt.method ?? ""}|${attempt.userId ?? ""}`;
    const now = this.now();
    const open = this.windows.get(key);
    const ip = currentAuditContext()?.ip ?? null;
    if (open && now - open.start < this.windowMs) {
      open.suppressed += 1;
      if (ip && open.ips.size < MAX_TRACKED_IPS) open.ips.add(ip);
      return;
    }
    if (open) await this.summarize(open, now);
    this.windows.set(key, { attempt, start: now, suppressed: 0, ips: new Set() });
    await recordAuditAfter(this.db, eventOf(attempt));
  }

  /** Summarizes and closes windows that have ended (all of them with `all`). */
  async flush({ all = false }: { readonly all?: boolean } = {}): Promise<void> {
    const now = this.now();
    for (const [key, window] of [...this.windows]) {
      if (!all && now - window.start < this.windowMs) continue;
      this.windows.delete(key);
      await this.summarize(window, Math.min(now, window.start + this.windowMs));
    }
  }

  start(): void {
    this.timer ??= setInterval(() => void this.flush(), FLUSH_INTERVAL_MS);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.flush({ all: true });
  }

  private async summarize(window: Window, end: number): Promise<void> {
    if (window.suppressed === 0) return;
    const { attempt } = window;
    await recordAuditAfter(this.db, {
      action: "auth.attempts.summarized",
      actor: SYSTEM_ACTOR,
      target: {
        of: attempt.action,
        ...(attempt.method ? { method: attempt.method } : {}),
        ...(attempt.userId ? { userId: attempt.userId } : {}),
        suppressed: window.suppressed,
        distinctIps: window.ips.size,
        from: new Date(window.start).toISOString(),
        to: new Date(Math.max(end, window.start)).toISOString(),
      },
    });
  }
}

function eventOf(attempt: Attempt) {
  const user = { kind: "user" as const, id: null };
  switch (attempt.action) {
    case "auth.sign_in.failed":
      return {
        action: attempt.action,
        actor: user,
        target: {
          method: attempt.method ?? "password",
          reason: attempt.reason ?? "ERROR",
          ...(attempt.userId ? { userId: attempt.userId } : {}),
        },
      };
    case "auth.sign_in.two_factor_required":
      return {
        action: attempt.action,
        actor: { kind: "user" as const, id: attempt.userId },
        target: { method: attempt.method ?? "password" },
      };
    case "auth.password.reset_requested":
      return { action: attempt.action, actor: user, target: { userId: attempt.userId ?? "" } };
  }
}
