import {
  decideEgress,
  loadEgressCeiling,
  loadTeamEgressIn,
  normalizeHost,
  type KobeTx,
} from "@kobe/db";
import type { SemanticMemoryIssue } from "@kobe/protocol";
import { normaliseQuote } from "../quote-normalise.js";
import { undefang } from "./text.js";

/**
 * Links in a memory (KOBE-379, SM18): every link is named by its host, and judged by the
 * Workspace's egress model (egress access lane, D28): reachable when a pattern the Workspace
 * enabled and the Site ceiling still holds covers the host, exactly as the egress proxy decides
 * (`decideEgress`). Site items are judged by the Site ceiling (they reach every Workspace).
 * A host written with look-alike letters is named in its punycode form.
 */

export interface LinkHost {
  /** As people should read it: the canonical ASCII host (punycode for non-ASCII names). */
  readonly host: string;
  /** Canonical host for the egress decision; null for IP literals and malformed hosts. */
  readonly canonical: string | null;
  /** The host has non-ASCII letters (a look-alike of an ASCII name, or an IDN). */
  readonly lookalike: boolean;
}

/** `scheme://host`, `www.host`, or `host/path` (the host part only). */
const LINK =
  /\b(?:(?:https?|ftp|wss?):\/\/(?:[^\s/?#@]*@)?([^\s/?#<>"'`)\]]+)|(www\.[^\s/?#<>"'`)\]]+)|((?:[\p{L}\p{N}-]+\.)+\p{L}[\p{L}\p{N}-]+)(?=\/))/giu;

/** Distinct link hosts in `text`, in order of appearance (at most 20). */
export function extractLinkHosts(text: string): LinkHost[] {
  const seen = new Map<string, LinkHost>();
  for (const m of undefang(normaliseQuote(text)).matchAll(LINK)) {
    const raw = (m[1] ?? m[2] ?? m[3] ?? "").replace(/:\d+$/u, "").replace(/[.,;:!?]+$/u, "");
    if (raw === "") continue;
    const canonical = normalizeHost(raw);
    const host = canonical ?? raw.toLowerCase();
    if (seen.has(host)) continue;
    const lookalike =
      /[^\p{ASCII}]/u.test(raw) ||
      (canonical?.split(".").some((l) => l.startsWith("xn--")) ?? false);
    seen.set(host, { host, canonical, lookalike });
    if (seen.size >= 20) break;
  }
  return [...seen.values()];
}

/** The egress patterns a link is judged by: the Site ceiling, and the Workspace's enablement. */
export interface EgressModel {
  readonly ceiling: ReadonlySet<string>;
  /** Null: judge by the ceiling alone (Site items, or no Workspace in play). */
  readonly team: ReadonlySet<string> | null;
}

/**
 * Reads the egress model in the save's transaction. `teamId` must be the transaction's team
 * (`withTeam`); null reads the ceiling only.
 */
export async function readEgressModel(tx: KobeTx, teamId: string | null): Promise<EgressModel> {
  return {
    ceiling: new Set(await loadEgressCeiling(tx)),
    team: teamId === null ? null : new Set(await loadTeamEgressIn(tx, teamId)),
  };
}

/** Warnings for `links` under `model`: look-alike hosts, and hosts the sandboxes can't reach. */
export function linkWarnings(
  links: readonly LinkHost[],
  model: EgressModel,
): SemanticMemoryIssue[] {
  const lookalikes = links.filter((l) => l.lookalike).map((l) => l.host);
  const blocked = links
    .filter((l) => {
      if (l.canonical === null) return true;
      if (model.team === null)
        return !decideEgress(model.ceiling, model.ceiling, l.canonical).allowed;
      return !decideEgress(model.ceiling, model.team, l.canonical).allowed;
    })
    .map((l) => l.host);
  const where =
    model.team === null ? "the Site's internet allowlist" : "this workspace's internet access";
  const issues: SemanticMemoryIssue[] = [];
  if (lookalikes.length > 0)
    issues.push({
      code: "link_lookalike",
      message: clip(
        `Links to ${lookalikes.join(", ")}: the address uses look-alike letters. Check it is the site you mean.`,
      ),
    });
  if (blocked.length > 0)
    issues.push({
      code: "link_blocked",
      message: clip(`Links to ${blocked.join(", ")}, which ${where} doesn't allow.`),
    });
  return issues;
}

/** The contract caps an issue message at 500 characters. */
const clip = (s: string): string => (s.length <= 500 ? s : `${s.slice(0, 497)}...`);
