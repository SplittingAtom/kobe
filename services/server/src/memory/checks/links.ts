import {
  decideEgress,
  isRegistrableHost,
  loadEgressCeiling,
  loadTeamEgressIn,
  normalizeHost,
  type KobeTx,
} from "@kobe/db";
import type { SemanticMemoryIssue, SemanticMemoryScope } from "@kobe/protocol";
import { normaliseQuote } from "../quote-normalise.js";
import { undefang } from "./text.js";

/**
 * Links in a memory (KOBE-379, SM18): every link is named by its host, and judged by the
 * Workspace's egress model (egress access lane, D28): reachable when a pattern the Workspace
 * enabled and the Site ceiling still holds covers the host, exactly as the egress proxy decides
 * (`decideEgress`). Site and portable items are judged by the Site ceiling: they reach every
 * Workspace (a portable item follows its owner), so no one Workspace's choice decides (KOBE-379
 * review L-5). A host written with look-alike letters is named in its punycode form.
 *
 * Links are found as `scheme://host`, `scheme:host` and `scheme:/\host` (WHATWG reads all three
 * as a link), `www.host`, `host/path`, and bare names under an ICANN public suffix (`evil.de`),
 * except names ending in a common file extension that is also a country code (`README.md`,
 * `main.py`). Review L-4.
 */

export interface LinkHost {
  /** As people should read it: the canonical ASCII host (punycode for non-ASCII names). */
  readonly host: string;
  /** Canonical host for the egress decision; null for IP literals and malformed hosts. */
  readonly canonical: string | null;
  /** The host has non-ASCII letters (a look-alike of an ASCII name, or an IDN). */
  readonly lookalike: boolean;
}

/**
 * `scheme:` + up to two slashes or backslashes + host, `www.host`, `host/path`, or a bare
 * `label.tld` (not inside an email address or a longer name).
 */
const LINK =
  /\b(?:(?:https?|ftp|wss?):[\\/]{0,2}(?:[^\s/\\?#@]*@)?([^\s/\\?#<>"'`)\]]+)|(www\.[^\s/\\?#<>"'`)\]]+)|((?:[\p{L}\p{N}-]+\.)+\p{L}[\p{L}\p{N}-]+)(?=\/))|(?<![\p{L}\p{N}@._/-])((?:[\p{L}\p{N}-]{1,63}\.){1,8}\p{L}{2,24})(?![\p{L}\p{N}@-]|\.[\p{L}\p{N}])/giu;

/** File extensions that are also country-code TLDs: `README.md` is a file, not a site. */
const FILE_EXTENSIONS: ReadonlySet<string> = new Set([
  "cc",
  "in",
  "md",
  "mk",
  "ml",
  "mov",
  "pl",
  "pm",
  "ps",
  "py",
  "rs",
  "sc",
  "sh",
  "so",
  "tf",
  "zip",
]);

/** A bare name counts as a link when it is a registrable name and not a file name. */
function bareHost(raw: string): boolean {
  const tld = raw.slice(raw.lastIndexOf(".") + 1).toLowerCase();
  if (FILE_EXTENSIONS.has(tld)) return false;
  const canonical = normalizeHost(raw);
  return canonical !== null && isRegistrableHost(canonical);
}

/** Distinct link hosts in `text`, in order of appearance (at most 20). */
export function extractLinkHosts(text: string): LinkHost[] {
  const seen = new Map<string, LinkHost>();
  for (const m of undefang(normaliseQuote(text)).matchAll(LINK)) {
    if (m[4] !== undefined && !bareHost(m[4])) continue;
    const raw = (m[1] ?? m[2] ?? m[3] ?? m[4] ?? "")
      .replace(/:\d+$/u, "")
      .replace(/[.,;:!?]+$/u, "");
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
  /** Null: judge by the ceiling alone (Site and portable items, or no Workspace in play). */
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

/** The Workspace whose egress judges a link in an item of `scope`; null = the Site ceiling. */
export const egressTeamFor = (scope: SemanticMemoryScope, teamId: string | null): string | null =>
  scope === "user" || scope === "team" ? teamId : null;

/**
 * Warnings for `links` under `model`: look-alike hosts, and hosts the sandboxes can't reach.
 * `scope` words the message (a portable item reaches every Workspace the person joins).
 */
export function linkWarnings(
  links: readonly LinkHost[],
  model: EgressModel,
  scope?: SemanticMemoryScope,
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
    model.team !== null
      ? "this workspace's internet access"
      : scope === "portable"
        ? "the Site's internet allowlist (this memory follows you into every workspace, and each may allow less)"
        : "the Site's internet allowlist";
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
