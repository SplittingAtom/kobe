import type { Logger } from "pino";
import { INVALID_RENEWALS_MAX } from "./connection-limits.js";
import type { SandboxTarget, SessionTokenVerifier } from "./types.js";

/** What a connection's session expiry needs from it. */
export interface SessionExpiryHost {
  readonly verifyToken: SessionTokenVerifier;
  readonly sandboxId: string;
  readonly target: SandboxTarget;
  readonly graceMs: number;
  readonly log: Pick<Logger, "warn" | "debug">;
  close(reason: "unauthorized", message: string): void;
  /** Re-checks liveness, account and membership (a renewal never outlives offboarding). */
  revalidate(): void;
}

/**
 * The session token expires (15 min, KOBE-22). An agent with `session_renew` hands over its fresh
 * token in band before then (KOBE-483) and the deadline moves; otherwise the sandbox reconnects
 * with a fresh one and resumes its runs from their durable cursors. (KOBE-706: moved out of
 * connection.ts.)
 */
export class SessionExpiry {
  readonly #h: SessionExpiryHost;
  #expiresAt: number;
  #timer: NodeJS.Timeout | undefined;
  #invalidRenewals = 0;

  constructor(host: SessionExpiryHost, expiresAtMs: number) {
    this.#h = host;
    this.#expiresAt = expiresAtMs;
  }

  arm(): void {
    clearTimeout(this.#timer);
    const expiresIn = this.#expiresAt - Date.now() + this.#h.graceMs;
    this.#timer = setTimeout(
      () => this.#h.close("unauthorized", "session token expired"),
      Math.max(0, expiresIn),
    );
    this.#timer.unref();
  }

  clear(): void {
    clearTimeout(this.#timer);
  }

  /**
   * `session.renew` (KOBE-483): a fresh token for the same (sandbox, team, user, eval thread) moves
   * the expiry; a token for any other identity closes the connection; an invalid or expired one is
   * ignored (the old deadline stands). Never logs the token.
   */
  renew(token: string, announced: boolean): void {
    const { log, sandboxId, target } = this.#h;
    if (!announced) {
      log.warn({ sandbox_id: sandboxId }, "session.renew without the capability ignored");
      return;
    }
    let claims: ReturnType<SessionTokenVerifier>;
    try {
      claims = this.#h.verifyToken(token);
    } catch {
      this.#invalidRenewals += 1;
      log.warn({ sandbox_id: sandboxId }, "session.renew with an invalid token ignored");
      if (this.#invalidRenewals >= INVALID_RENEWALS_MAX)
        this.#h.close("unauthorized", "too many invalid session renewals");
      return;
    }
    const sameIdentity =
      claims.sub === sandboxId &&
      claims.team_id === target.teamId &&
      claims.user_id === target.userId &&
      claims.eval_thread === target.evalThreadId;
    if (!sameIdentity) {
      log.warn({ sandbox_id: sandboxId, security: true }, "session.renew for another identity");
      this.#h.close("unauthorized", "renewed token names another identity");
      return;
    }
    const expiresAt = claims.exp * 1000;
    if (expiresAt <= Date.now() || expiresAt <= this.#expiresAt) return;
    this.#expiresAt = expiresAt;
    this.arm();
    // A renewal never outlives offboarding: re-check liveness, account and membership now.
    this.#h.revalidate();
    log.debug({ sandbox_id: sandboxId, expires_at: expiresAt }, "session renewed");
  }
}
