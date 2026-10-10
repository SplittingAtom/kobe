import type { BudgetLine } from "@kobe/db";

/**
 * In-flight budget reservations (KOBE-42 review, shared across replicas by KOBE-120): what an
 * admitted call may still cost, held at its install, team and member levels until it ends.
 */

/** Of what is left on a shared (install or team) line, the most one member's calls can hold. */
export const MEMBER_SHARE = 0.25;

export interface Cost {
  readonly usd: number;
  readonly tokens: number;
}

export interface ReserveRequest {
  readonly teamId: string;
  readonly userId: string;
  readonly callId: string;
  readonly cost: Cost;
  /** The member's budget lines as the gate read them (spend included). */
  readonly lines: readonly BudgetLine[];
}

export type ReserveVerdict =
  | { readonly ok: true }
  /** `line`: index into the request's lines. `full`: spend plus reservations reach the limit. */
  | { readonly ok: false; readonly verdict: "full" | "own_share"; readonly line: number };

export interface ReservationStore {
  /** Checks the lines against the live reservations and, if they allow it, holds the cost. */
  reserve(request: ReserveRequest): Promise<ReserveVerdict>;
  /** Heartbeat of calls still running: keeps their live reservations from expiring. */
  extend(teamId: string, callIds: readonly string[]): Promise<void>;
  /**
   * Ends these calls' reservations. With `keepMs`, they stay that long (at most as long as they
   * would anyway): the call ended but its ledger row has not landed yet.
   */
  end(teamId: string, callIds: readonly string[], keepMs?: number): Promise<void>;
}
