import { unzipSync } from "fflate";
import { scanTeams, sql, withTeam, type KobeDb, type KobeTx } from "@kobe/db";
import type { BlobStore } from "../retention/blobs.js";
import { readVerified } from "./blob-read.js";
import { MIN_TEAMS } from "./catalog-admin.js";
import { readPackage } from "./registry/review-diff.js";

/**
 * The member's Catalog tab (KOBE-336, SK25): every catalog skill with an approved version, as seen
 * from the active team. Site-wide records (names, summaries, approved versions, numbers) plus this
 * team's own state (its install, the caller's add, a block), each read under the team's RLS.
 * Browsers never get a version's `source`, provenance, submitter or the Registry's notes: those
 * are reviewers' (KOBE-334). Cross-team numbers obey the minimum-count rule (SK26): fewer than
 * three teams show as "few", and no team is ever named.
 */

export const CATALOG_SORTS = ["name", "updated", "teams"] as const;
export type CatalogSort = (typeof CATALOG_SORTS)[number];

export interface CatalogQuery {
  readonly q: string;
  readonly tag: string | null;
  readonly sort: CatalogSort;
}

/** A card's numbers from the version's authoritative scorecard (SK23), when it has one. */
export interface CardScore {
  readonly passRate: number | null;
  readonly lift: number | null;
  readonly cases: number | null;
}

export interface TeamState {
  /** The team's install: its version and modes; null when not installed. */
  readonly installed: {
    readonly semver: string | null;
    readonly pinMode: string;
    readonly access: string;
  } | null;
  /** The caller added it for themselves in this team (SK25 member add). */
  readonly addedByMe: boolean;
  /** A Team admin blocked it in this team. */
  readonly blocked: boolean;
}

export interface CatalogCard {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly publisher: string;
  readonly status: string;
  readonly topics: readonly string[];
  readonly latest: {
    readonly versionId: string;
    readonly semver: string;
    readonly verdict: string;
    readonly approvedAt: string | null;
  };
  readonly score: CardScore | null;
  /** Teams that installed it: a count, or "few" under the minimum-count rule. */
  readonly teamsInstalled: number | "few";
  readonly state: TeamState;
}

const num = (v: unknown): number | null => (typeof v === "number" ? v : null);

export function cardScore(card: Record<string, unknown> | null): CardScore | null {
  if (!card) return null;
  return { passRate: num(card.passRateWith), lift: num(card.lift), cases: num(card.cases) };
}

/** Installs per catalog skill across teams (each read under its own RLS), cached briefly. */
let installCounts: { at: number; counts: Map<string, number> } | null = null;
const INSTALL_COUNTS_TTL_MS = 5 * 60_000;

async function teamsInstalled(db: KobeDb): Promise<Map<string, number>> {
  if (installCounts && Date.now() - installCounts.at < INSTALL_COUNTS_TTL_MS)
    return installCounts.counts;
  const rows = await scanTeams(db, "catalogInstallCounts", async (tx, team) => {
    const r = await tx.execute<{ skill_id: string }>(sql`
      SELECT skill_id FROM team_skill_installs WHERE team_id = ${team.id}`);
    return r.rows.map((x) => x.skill_id);
  });
  const counts = new Map<string, number>();
  for (const id of rows.flat()) counts.set(id, (counts.get(id) ?? 0) + 1);
  installCounts = { at: Date.now(), counts };
  return counts;
}

/** Tests: forget the cached install counts. */
export function forgetInstallCounts(): void {
  installCounts = null;
}

const shown = (n: number): number | "few" => (n > 0 && n < MIN_TEAMS ? "few" : n);

type CardRow = Record<string, unknown> & {
  id: string;
  name: string;
  summary: string;
  publisher: string;
  status: string;
  updated_at: Date;
  version_id: string;
  semver: string;
  verdict: string;
  approved_at: Date | null;
  authoritative_scorecard: Record<string, unknown> | null;
  topics: string[] | null;
  install_semver: string | null;
  pin_mode: string | null;
  access: string | null;
  added_by_me: boolean;
  blocked: boolean;
};

/** The newest approved, unsuspended version of each skill (what a card shows). */
const LATEST = sql`
  SELECT v.id, v.semver, v.verdict::text AS verdict, v.approved_at, v.authoritative_scorecard
    FROM registry_versions v
   WHERE v.skill_id = s.id AND v.state = 'approved' AND v.suspended_at IS NULL
   ORDER BY v.seq DESC LIMIT 1`;

/** The rows of the cards, filtered (inside the team's transaction). */
async function cardRows(
  tx: KobeTx,
  who: { readonly teamId: string; readonly userId: string },
  query: CatalogQuery,
  skillId?: string,
): Promise<CardRow[]> {
  const search = query.q.trim();
  const res = await tx.execute<CardRow>(sql`
    SELECT s.id, s.name, s.summary, s.publisher::text AS publisher, s.status::text AS status,
      s.updated_at, l.id AS version_id, l.semver, l.verdict, l.approved_at,
      l.authoritative_scorecard,
      array(SELECT t.name FROM registry_skill_tags st JOIN registry_tags t ON t.id = st.tag_id
             WHERE st.skill_id = s.id AND t.kind = 'topic' AND t.status = 'active'
             ORDER BY t.name) AS topics,
      iv.semver AS install_semver, i.pin_mode::text AS pin_mode, i.access::text AS access,
      EXISTS (SELECT 1 FROM member_skill_enablements e
               WHERE e.team_id = ${who.teamId} AND e.user_id = ${who.userId}
                 AND e.catalog_skill_id = s.id AND e.enabled) AS added_by_me,
      EXISTS (SELECT 1 FROM team_skill_blocks b
               WHERE b.team_id = ${who.teamId} AND b.skill_id = s.id) AS blocked
      FROM registry_skills s
      JOIN LATERAL (${LATEST}) l ON true
      LEFT JOIN team_skill_installs i ON i.team_id = ${who.teamId} AND i.skill_id = s.id
      LEFT JOIN registry_versions iv ON iv.id = i.version_id
     WHERE s.status <> 'archived'
       ${skillId ? sql`AND s.id = ${skillId}` : sql``}
       ${
         search
           ? sql`AND to_tsvector('english', replace(s.name, '-', ' ') || ' ' || s.summary)
                   @@ websearch_to_tsquery('english', ${search})`
           : sql``
       }
       ${
         query.tag
           ? sql`AND EXISTS (SELECT 1 FROM registry_skill_tags st
                               JOIN registry_tags t ON t.id = st.tag_id
                              WHERE st.skill_id = s.id AND t.name = ${query.tag})`
           : sql``
       }
     ORDER BY s.name
     LIMIT 500`);
  return res.rows;
}

function toCard(r: CardRow, counts: Map<string, number>): CatalogCard {
  return {
    id: r.id,
    name: r.name,
    summary: r.summary,
    publisher: r.publisher,
    status: r.status,
    topics: r.topics ?? [],
    latest: {
      versionId: r.version_id,
      semver: r.semver,
      verdict: r.verdict,
      approvedAt: r.approved_at ? new Date(r.approved_at).toISOString() : null,
    },
    score: cardScore(r.authoritative_scorecard),
    teamsInstalled: shown(counts.get(r.id) ?? 0),
    state: {
      installed: r.pin_mode
        ? { semver: r.install_semver, pinMode: r.pin_mode, access: r.access ?? "available" }
        : null,
      addedByMe: r.added_by_me,
      blocked: r.blocked,
    },
  };
}

const rank = (t: number | "few") => (t === "few" ? 1 : t);

export interface CatalogPage {
  readonly skills: readonly CatalogCard[];
  /** Every active topic tag, for the filter. */
  readonly tags: readonly string[];
}

export async function browseCatalog(
  db: KobeDb,
  who: { readonly teamId: string; readonly userId: string },
  query: CatalogQuery,
): Promise<CatalogPage> {
  const rows = await withTeam(db, who.teamId, (tx) => cardRows(tx, who, query));
  const counts = await teamsInstalled(db);
  const cards = rows.map((r) => toCard(r, counts));
  const updated = new Map(rows.map((r) => [r.id, new Date(r.updated_at).getTime()]));
  const sorted =
    query.sort === "updated"
      ? [...cards].sort((a, b) => (updated.get(b.id) ?? 0) - (updated.get(a.id) ?? 0))
      : query.sort === "teams"
        ? [...cards].sort(
            (a, b) =>
              rank(b.teamsInstalled) - rank(a.teamsInstalled) || a.name.localeCompare(b.name),
          )
        : cards;
  const tags = await db.execute<{ name: string }>(sql`
    SELECT name FROM registry_tags WHERE kind = 'topic' AND status = 'active' ORDER BY name`);
  return { skills: sorted, tags: tags.rows.map((t) => t.name) };
}

export interface CatalogVersion {
  readonly id: string;
  readonly semver: string;
  readonly state: string;
  readonly approvedAt: string | null;
  readonly changelog: string | null;
  readonly verdict: string;
}

export interface EgressNeed {
  readonly host: string;
  /** Enabled for this team's sandboxes (and in the site ceiling). */
  readonly enabledHere: boolean;
  /** In the site egress ceiling: a member can request it (D28); otherwise only a Site admin. */
  readonly inCeiling: boolean;
}

export interface CatalogDetail extends CatalogCard {
  readonly skillMd: string | null;
  readonly files: readonly { readonly path: string; readonly size: number }[];
  readonly versions: readonly CatalogVersion[];
  /** The latest version's authoritative scorecard: numbers only (the re-run's facts left out). */
  readonly authoritativeScorecard: Record<string, unknown> | null;
  readonly license: string | null;
  readonly egress: readonly EgressNeed[];
  readonly packages: Record<string, unknown>;
  readonly maintainers: readonly string[];
  /** This team's agents whose current version names the skill. */
  readonly agents: readonly { readonly id: string; readonly name: string }[];
}

const PUBLISHED = ["approved", "deprecated", "withdrawn", "revoked"];

async function versionsOf(db: KobeDb, skillId: string): Promise<CatalogVersion[]> {
  const res = await db.execute<{
    id: string;
    semver: string;
    state: string;
    approved_at: Date | null;
    manifest: Record<string, unknown>;
    verdict: string;
  }>(sql`
    SELECT id, semver, state::text AS state, approved_at, manifest, verdict::text AS verdict
      FROM registry_versions
     WHERE skill_id = ${skillId} AND state::text IN (${sql.join(
       PUBLISHED.map((s) => sql`${s}`),
       sql`, `,
     )})
     ORDER BY seq DESC`);
  return res.rows.map((r) => ({
    id: r.id,
    semver: r.semver,
    state: r.state,
    approvedAt: r.approved_at ? new Date(r.approved_at).toISOString() : null,
    changelog: typeof r.manifest.changelog === "string" ? r.manifest.changelog : null,
    verdict: r.verdict,
  }));
}

/** SKILL.md without its frontmatter (the card already shows the name and description). */
export function skillMdBody(text: string): string {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(text);
  return m ? text.slice(m[0].length) : text;
}

async function versionFiles(
  db: KobeDb,
  blobs: BlobStore | null,
  versionId: string,
): Promise<{ skillMd: string | null; files: { path: string; size: number }[] }> {
  if (!blobs) return { skillMd: null, files: [] };
  const res = await db.execute<{
    package_hash: string;
    package_storage_key: string | null;
    runtime_hash: string;
    runtime_storage_key: string | null;
    runtime_size_bytes: number | null;
  }>(sql`
    SELECT package_hash, package_storage_key, runtime_hash, runtime_storage_key, runtime_size_bytes
      FROM registry_versions WHERE id = ${versionId}`);
  const v = res.rows[0];
  if (!v?.runtime_storage_key) return { skillMd: null, files: [] };
  const runtime = await readVerified(
    blobs,
    v.runtime_storage_key,
    v.runtime_hash,
    v.runtime_size_bytes,
  ).catch(() => null);
  const pkg = await readPackage(blobs, {
    packageHash: v.package_hash,
    packageStorageKey: v.package_storage_key,
    runtimeHash: v.runtime_hash,
    runtimeStorageKey: v.runtime_storage_key,
    runtimeSizeBytes: v.runtime_size_bytes,
  }).catch(() => null);
  const md = runtime ? unzipSync(runtime)["SKILL.md"] : undefined;
  const files = pkg
    ? Object.entries(unzipSync(pkg))
        .filter(([p]) => !p.endsWith("/"))
        .map(([path, bytes]) => ({ path, size: bytes.length }))
        .sort((a, b) => (a.path < b.path ? -1 : 1))
    : [];
  return { skillMd: md ? skillMdBody(new TextDecoder().decode(md)) : null, files };
}

/** The skill's capabilities from its latest manifest, checked against this team's egress. */
async function egressNeeds(tx: KobeTx, teamId: string, hosts: readonly string[]) {
  if (hosts.length === 0) return [];
  const res = await tx.execute<{ domain: string; in_ceiling: boolean; enabled: boolean }>(sql`
    SELECT d.domain, d.in_ceiling,
      EXISTS (SELECT 1 FROM team_egress te WHERE te.team_id = ${teamId} AND te.domain = d.domain)
        AS enabled
      FROM egress_domains d
     WHERE d.domain IN (${sql.join(
       hosts.map((h) => sql`${h}`),
       sql`, `,
     )})`);
  const byHost = new Map(res.rows.map((r) => [r.domain, r]));
  return hosts.map((host): EgressNeed => {
    const r = byHost.get(host);
    return {
      host,
      inCeiling: r?.in_ceiling ?? false,
      enabledHere: !!r && r.in_ceiling && r.enabled,
    };
  });
}

/** This team's agents (current version, not archived) that name the skill. */
async function agentsUsing(tx: KobeTx, teamId: string, name: string) {
  const res = await tx.execute<{ id: string; name: string }>(sql`
    SELECT a.id, COALESCE(a.frontmatter ->> 'name', a.slug) AS name
      FROM team_agents a
      JOIN team_agent_versions v
        ON v.team_id = a.team_id AND v.agent_id = a.id AND v.version = a.current_version
     WHERE a.team_id = ${teamId} AND a.archived_at IS NULL
       AND (v.frontmatter -> 'skills' ? ${name}
            OR v.frontmatter -> 'skills' -> 'exclusive' ? ${name})
     ORDER BY name`);
  return res.rows;
}

export async function catalogDetail(
  db: KobeDb,
  blobs: BlobStore | null,
  who: { readonly teamId: string; readonly userId: string },
  skillId: string,
): Promise<CatalogDetail | null> {
  const found = await withTeam(db, who.teamId, async (tx) => {
    const rows = await cardRows(tx, who, { q: "", tag: null, sort: "name" }, skillId);
    const row = rows[0];
    if (!row) return null;
    const m = await tx.execute<{ manifest: Record<string, unknown> }>(sql`
      SELECT manifest FROM registry_versions WHERE id = ${row.version_id}`);
    const manifest = m.rows[0]?.manifest ?? {};
    const caps = (manifest.capabilities ?? {}) as { egress?: unknown; packages?: unknown };
    const hosts = Array.isArray(caps.egress)
      ? caps.egress.filter((h): h is string => typeof h === "string")
      : [];
    return {
      row,
      manifest,
      packages:
        caps.packages && typeof caps.packages === "object"
          ? (caps.packages as Record<string, unknown>)
          : {},
      egress: await egressNeeds(tx, who.teamId, hosts),
      agents: await agentsUsing(tx, who.teamId, row.name),
    };
  });
  if (!found) return null;
  const { row, manifest } = found;
  const card = toCard(row, await teamsInstalled(db));
  const maintainers = await db.execute<{ name: string }>(sql`
    SELECT u.name FROM registry_maintainers m JOIN users u ON u.id = m.user_id
     WHERE m.skill_id = ${skillId} AND u.deactivated_at IS NULL ORDER BY u.name`);
  const { skillMd, files } = await versionFiles(db, blobs, row.version_id);
  const authoritative = row.authoritative_scorecard
    ? Object.fromEntries(Object.entries(row.authoritative_scorecard).filter(([k]) => k !== "rerun"))
    : null;
  return {
    ...card,
    skillMd,
    files,
    versions: await versionsOf(db, skillId),
    authoritativeScorecard: authoritative,
    license: typeof manifest.license === "string" ? manifest.license : null,
    egress: found.egress,
    packages: found.packages,
    maintainers: maintainers.rows.map((r) => r.name),
    agents: found.agents,
  };
}
