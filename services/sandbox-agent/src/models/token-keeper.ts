import type { ModelTokenSource } from "./types.js";

export interface TokenGrant {
  readonly token: string;
  /** Epoch ms. */
  readonly expiresAt: number;
}

export interface ModelTokenKeeperOptions {
  /**
   * The current grant, trading a new one when the old is within the session client's refresh
   * margin (session/exchange.ts `grant()`: retried until it succeeds).
   */
  readonly grant: () => Promise<TokenGrant>;
  /** The session client's refresh margin: the keeper asks just inside it. */
  readonly refreshMarginMs: number;
  readonly now?: () => number;
  readonly setTimer?: (fn: () => void, ms: number) => { unref?: () => void };
  readonly clearTimer?: (timer: unknown) => void;
  readonly logger?: { warn(obj: object, msg: string): void };
}

/** Keeps asking just inside the margin so a stuck trade cannot stall for a whole token lifetime. */
const RETRY_MS = 5_000;
const INSIDE_MARGIN_MS = 1_000;

/**
 * Proactive model-gateway token rotation (KOBE-41). The session client re-trades lazily (when
 * asked near expiry); nothing asks it during a long run, so this keeper schedules the next trade
 * itself, just inside the refresh margin (expiry − margin + 1 s), and hands every new token to its
 * listeners — the threads, which rewrite their Pi processes' model files. A streaming model call
 * is never touched: Pi reads the file when it starts a request, and the gateway checks the token
 * only then.
 */
export class ModelTokenKeeper implements ModelTokenSource {
  readonly #o: ModelTokenKeeperOptions;
  readonly #listeners = new Set<(token: string) => void>();
  #token: string | undefined;
  #timer: unknown;
  #stopped = false;
  #pending: Promise<string> | undefined;

  constructor(options: ModelTokenKeeperOptions) {
    this.#o = options;
  }

  /** Trades (or reuses) a grant now and schedules the next trade. */
  start(): Promise<string> {
    return this.#refresh();
  }

  stop(): void {
    this.#stopped = true;
    this.#clear();
  }

  current(): Promise<string> {
    return this.#token !== undefined ? Promise.resolve(this.#token) : this.#refresh();
  }

  onChange(listener: (token: string) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #refresh(): Promise<string> {
    this.#pending ??= this.#refreshOnce().finally(() => {
      this.#pending = undefined;
    });
    return this.#pending;
  }

  async #refreshOnce(): Promise<string> {
    const now = this.#o.now ?? Date.now;
    let grant: TokenGrant;
    try {
      grant = await this.#o.grant();
    } catch (error) {
      this.#o.logger?.warn({ err: (error as Error).message }, "model token trade failed; retrying");
      this.#schedule(RETRY_MS);
      if (this.#token !== undefined) return this.#token;
      throw error;
    }
    if (grant.token !== this.#token) {
      this.#token = grant.token;
      for (const listener of this.#listeners) listener(grant.token);
    }
    const due = grant.expiresAt - this.#o.refreshMarginMs + INSIDE_MARGIN_MS - now();
    this.#schedule(Math.max(due, RETRY_MS));
    return grant.token;
  }

  #schedule(ms: number): void {
    this.#clear();
    if (this.#stopped) return;
    const set = this.#o.setTimer ?? ((fn, delay) => setTimeout(fn, delay));
    const timer = set(() => void this.#refresh().catch(() => undefined), ms);
    timer.unref?.();
    this.#timer = timer;
  }

  #clear(): void {
    if (this.#timer === undefined) return;
    (this.#o.clearTimer ?? ((t) => clearTimeout(t as NodeJS.Timeout)))(this.#timer);
    this.#timer = undefined;
  }
}
