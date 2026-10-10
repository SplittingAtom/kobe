import type { BudgetLine } from "@kobe/db";
import {
  MEMBER_SHARE,
  type Cost,
  type ReservationStore,
  type ReserveRequest,
  type ReserveVerdict,
} from "./reservations.js";

interface Held {
  readonly keys: readonly string[];
  readonly member: string;
  readonly cost: Cost;
  timer?: NodeJS.Timeout;
}

/**
 * Reservations in this process's memory: the pre-KOBE-120 behaviour, kept for tests and for a
 * single replica without a database. Replicas do not see each other's reservations.
 */
export class MemoryReservations implements ReservationStore {
  /** Line key → member (`team:user`) → reserved. */
  private readonly reserved = new Map<string, Map<string, Cost>>();
  private readonly held = new Map<string, Held>();

  async reserve(r: ReserveRequest): Promise<ReserveVerdict> {
    const member = `${r.teamId}:${r.userId}`;
    const keys = {
      install: "install",
      team: `team:${r.teamId}`,
      user: `user:${r.teamId}:${r.userId}`,
    };
    // No await from the checks to the reservation: concurrent calls cannot pass the same check.
    for (const [index, l] of r.lines.entries()) {
      const verdict = this.inFlight(l, keys[l.scope], member, r.cost);
      if (verdict !== "ok") return { ok: false, verdict, line: index };
    }
    const all = [keys.install, keys.team, keys.user];
    for (const k of all) this.add(k, member, r.cost, 1);
    this.held.set(r.callId, { keys: all, member, cost: r.cost });
    return { ok: true };
  }

  async end(_teamId: string, callIds: readonly string[], keepMs?: number): Promise<void> {
    for (const id of callIds) {
      const h = this.held.get(id);
      if (!h) continue;
      if (keepMs === undefined || keepMs <= 0) {
        this.drop(id, h);
      } else if (!h.timer) {
        h.timer = setTimeout(() => this.drop(id, h), keepMs);
        h.timer.unref();
      }
    }
  }

  private drop(id: string, h: Held): void {
    if (this.held.get(id) !== h) return;
    this.held.delete(id);
    if (h.timer) clearTimeout(h.timer);
    for (const k of h.keys) this.add(k, h.member, h.cost, -1);
  }

  /**
   * In-flight reservations against one budget line. On a shared line (install, team) each
   * member's reservations count only up to their share of what is left, so one sandbox reserving
   * large calls cannot deny everyone else; that member alone is refused once its own reach it.
   */
  private inFlight(
    line: BudgetLine,
    lineKey: string,
    member: string,
    cost: Cost,
  ): "ok" | "full" | "own_share" {
    const byMember = this.reserved.get(lineKey);
    if (!byMember) return "ok";
    const left = Math.max(0, line.limit - line.spent);
    const share = line.scope === "user" ? Number.POSITIVE_INFINITY : left * MEMBER_SHARE;
    let total = 0;
    for (const r of byMember.values()) total += Math.min(r[line.unit], share);
    if (line.spent + total >= line.limit) return "full";
    // The share caps the member's first call too (own = 0), whenever others hold reservations
    // (a lone call is always admitted: the line is then not shared in practice).
    const own = byMember.get(member)?.[line.unit] ?? 0;
    const others = [...byMember.keys()].some((m) => m !== member);
    return (own > 0 || others) && own + cost[line.unit] > share ? "own_share" : "ok";
  }

  private add(lineKey: string, member: string, cost: Cost, sign: 1 | -1): void {
    const byMember = this.reserved.get(lineKey) ?? new Map<string, Cost>();
    const r = byMember.get(member) ?? { usd: 0, tokens: 0 };
    const next = { usd: r.usd + sign * cost.usd, tokens: r.tokens + sign * cost.tokens };
    if (next.tokens <= 0 && next.usd <= 1e-12) byMember.delete(member);
    else byMember.set(member, next);
    if (byMember.size === 0) this.reserved.delete(lineKey);
    else this.reserved.set(lineKey, byMember);
  }
}
