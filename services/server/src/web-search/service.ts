import {
  SYSTEM_ACTOR,
  eq,
  sql,
  teamWebSearch,
  webSearchSettings,
  withTeam,
  type Envelope,
  type KobeDb,
  type WebSearchProvider,
} from "@kobe/db";
import {
  WEB_SEARCHES_PER_RUN,
  WEB_SEARCH_UNAVAILABLE_MESSAGES,
  type WebSearchCitation,
  type WebSearchInput,
} from "@kobe/protocol";
import { recordAudit } from "../audit/record.js";
import { searchProvider } from "./search.js";
import { webSearchContext } from "./store.js";

/**
 * Runs a sandbox's `web_search` (KOBE-114). The server decides: it checks that the install offers
 * a provider and that this team opted in (KOBE-113), opens the install's sealed key, calls the
 * provider and returns citations. The key is never sent to a sandbox or the egress proxy.
 */
export type WebSearchAnswer =
  | {
      readonly kind: "results";
      readonly provider: WebSearchProvider;
      readonly results: readonly WebSearchCitation[];
    }
  | {
      readonly kind: "unavailable";
      readonly reason: "not_configured" | "team_not_enabled";
      readonly message: string;
    }
  | { readonly kind: "error"; readonly code: string; readonly message: string };

/** The call a search belongs to: counted per run in the database. */
export interface SearchCall {
  readonly runId: string;
  readonly toolCallId: string;
  readonly sandboxId: string;
  readonly userId: string;
}

export interface WebSearchService {
  search(teamId: string, input: WebSearchInput, call: SearchCall): Promise<WebSearchAnswer>;
}

export const SEARCHES_PER_TEAM_PER_MINUTE = 30;

export interface WebSearchServiceOptions {
  readonly db: KobeDb;
  /** Without the install envelope key there is no readable provider key: unavailable. */
  readonly envelope: Envelope | undefined;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly perTeamPerMinute?: number;
  /** Searches per run (default {@link WEB_SEARCHES_PER_RUN}); tests lower it. */
  readonly maxPerRun?: number;
}

const unavailable = (reason: "not_configured" | "team_not_enabled"): WebSearchAnswer => ({
  kind: "unavailable",
  reason,
  message: WEB_SEARCH_UNAVAILABLE_MESSAGES[reason],
});

export function createWebSearchService(options: WebSearchServiceOptions): WebSearchService {
  const now = options.now ?? Date.now;
  const limit = options.perTeamPerMinute ?? SEARCHES_PER_TEAM_PER_MINUTE;
  const maxPerRun = options.maxPerRun ?? WEB_SEARCHES_PER_RUN;
  const recent = new Map<string, number[]>();

  const takeSlot = (teamId: string): boolean => {
    const cutoff = now() - 60_000;
    const times = (recent.get(teamId) ?? []).filter((t) => t > cutoff);
    if (times.length >= limit) {
      recent.set(teamId, times);
      return false;
    }
    recent.set(teamId, [...times, now()]);
    return true;
  };

  return {
    async search(teamId, input, call) {
      const [install] = await options.db
        .select({
          provider: webSearchSettings.provider,
          enabled: webSearchSettings.enabled,
          sealed: webSearchSettings.sealed,
        })
        .from(webSearchSettings);
      if (!install?.enabled || !options.envelope) return unavailable("not_configured");
      const [optIn] = await withTeam(options.db, teamId, (tx) =>
        tx.select().from(teamWebSearch).where(eq(teamWebSearch.teamId, teamId)),
      );
      if (!optIn) return unavailable("team_not_enabled");
      if (!takeSlot(teamId)) {
        return {
          kind: "error",
          code: "rate_limited",
          message: "Too many searches; wait a moment.",
        };
      }
      const reserved = await reserveSearch(options.db, teamId, call, install.provider, maxPerRun);
      if (!reserved) {
        return {
          kind: "error",
          code: "run_limit",
          message: `This run has used its ${maxPerRun} web searches.`,
        };
      }
      let key: string;
      try {
        key = options.envelope.openString(install.sealed, webSearchContext);
      } catch {
        // A key that no longer opens (rotated install secret) is the admin's to fix.
        return unavailable("not_configured");
      }
      const outcome = await searchProvider(install.provider, key, input, options.fetch);
      if (!outcome.ok) return { kind: "error", code: outcome.code, message: outcome.message };
      return { kind: "results", provider: install.provider, results: outcome.results };
    },
  };
}

const ACTION = "sandbox.web_search_queried";

/**
 * Takes one of the run's {@link WEB_SEARCHES_PER_RUN} searches. The count is read from the audit
 * rows this writes, under a per-run advisory lock, so replicas share one count. False: cap reached.
 */
async function reserveSearch(
  db: KobeDb,
  teamId: string,
  call: SearchCall,
  provider: WebSearchProvider,
  max: number,
): Promise<boolean> {
  return withTeam(db, teamId, async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`web_search:${call.runId}`}, 0))`,
    );
    const counted = await tx.execute(
      sql`SELECT count(*)::int AS n FROM audit_log
          WHERE action = ${ACTION} AND team_id = ${teamId} AND target->>'runId' = ${call.runId}`,
    );
    const used = Number((counted.rows[0] as { n?: number } | undefined)?.n ?? 0);
    if (used >= max) return false;
    await recordAudit(tx, {
      action: ACTION,
      actor: SYSTEM_ACTOR,
      teamId,
      target: {
        sandboxId: call.sandboxId,
        userId: call.userId,
        runId: call.runId,
        toolCallId: call.toolCallId,
        provider,
      },
    });
    return true;
  });
}
