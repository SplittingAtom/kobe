import { unzipSync } from "fflate";
import { catalogSkillEvalScorecardSchema } from "@kobe/protocol";
import { sql, withTeam, type KobeDb, type KobeTx, type TeamRole } from "@kobe/db";
import { siteRoleAllows, teamRoleAllows, type SiteRole } from "../authz/permissions.js";
import { skillStanding } from "./retirement-state.js";
import type { BlobStore } from "../retention/blobs.js";
import { readVerified } from "./blob-read.js";
import { usageSnapshot, viewerTeamsOf } from "./usage-snapshot.js";
import { cardUsage, type CardUsage } from "./usage-views.js";
import { hostStandings } from "../egress/host-standing.js";
import { readPackage } from "./registry/review-diff.js";
import { readCatalogSwitches } from "./settings.js";

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
  /** The caller's Add for me here: its version and pin mode (KOBE-338). */
  readonly myAdd: { readonly semver: string; readonly pinMode: string } | null;
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
  /** Teams that installed it: a count, or "few" under the minimum-count rule (KOBE-339). */
  readonly teamsInstalled: number | "few";
  /** Members using it and the thumbs-up share in the window, under the same rule. */
  readonly usage: { readonly members: number | "few"; readonly thumbsUp: number | "few" };
  readonly state: TeamState;
}

const num = (v: unknown): number | null => (typeof v === "number" ? v : null);

export function cardScore(card: Record<string, unknown> | null): CardScore | null {
  if (!card) return null;
  return { passRate: num(card.passRateWith), lift: num(card.lift), cases: num(card.cases) };
}

/** The viewer's usage numbers from the nightly snapshot (KOBE-339): one per card. */
type UsageOf = ((skillId: string) => CardUsage) & {
  readonly window: { readonly from: string; readonly to: string };
};

async function usageFor(
  db: KobeDb,
  who: { readonly teamId: string; readonly userId: string },
): Promise<UsageOf> {
  const snapshot = await usageSnapshot(db);
  // The viewer's teams now (review M3), not when the window was computed.
  const viewer = await viewerTeamsOf(db, who.userId, who.teamId);
  return Object.assign((skillId: string) => cardUsage(snapshot, skillId, viewer), {
    window: { from: snapshot.from, to: snapshot.to },
  });
}

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
  add_semver: string | null;
  add_pin_mode: string | null;
  blocked: boolean;
};

/** The newest approved, unsuspended version of each skill (what a card shows). */
const LATEST = sql`
  SELECT v.id, v.semver, v.verdict::text AS verdict, v.approved_at, v.authoritative_scorecard
    FROM registry_versions v
   WHERE v.skill_id = s.id AND v.state = 'approved' AND v.suspended_at IS NULL
   ORDER BY v.seq DESC LIMIT 1`;

/** The most cards one page shows. */
export const CATALOG_LIMIT = 500;

/** The rows of the cards, filtered (inside the team's transaction). */
async function cardRows(
  tx: KobeTx,
  who: { readonly teamId: string; readonly userId: string },
  query: CatalogQuery,
  skillId?: string,
  teamRanks?: ReadonlyMap<string, number>,
): Promise<CardRow[]> {
  const search = query.q.trim();
  // Sorted in SQL before the limit (review-336 L5). "Teams installed" ranks by the shown counts
  // ("few" ranks as 1), so the order reveals nothing the cards don't.
  const ranks = JSON.stringify(Object.fromEntries(teamRanks ?? []));
  const order =
    query.sort === "updated"
      ? sql`s.updated_at DESC, s.name`
      : query.sort === "teams"
        ? sql`COALESCE((${ranks}::jsonb ->> s.id::text)::int, 0) DESC, s.name`
        : sql`s.name`;
  const res = await tx.execute<CardRow>(sql`
    SELECT s.id, s.name, s.summary, s.publisher::text AS publisher, s.status::text AS status,
      s.updated_at, l.id AS version_id, l.semver, l.verdict, l.approved_at,
      l.authoritative_scorecard,
      array(SELECT t.name FROM registry_skill_tags st JOIN registry_tags t ON t.id = st.tag_id
             WHERE st.skill_id = s.id AND t.kind = 'topic' AND t.status = 'active'
             ORDER BY t.name) AS topics,
      iv.semver AS install_semver, i.pin_mode::text AS pin_mode, i.access::text AS access,
      ma.semver IS NOT NULL AS added_by_me, ma.semver AS add_semver, ma.pin_mode AS add_pin_mode,
      EXISTS (SELECT 1 FROM team_skill_blocks b
               WHERE b.team_id = ${who.teamId} AND b.skill_id = s.id) AS blocked
      FROM registry_skills s
      JOIN LATERAL (${LATEST}) l ON true
      LEFT JOIN team_skill_installs i ON i.team_id = ${who.teamId} AND i.skill_id = s.id
      LEFT JOIN registry_versions iv ON iv.id = i.version_id
      -- The caller's own Add for me (KOBE-338): a row with a version, not an on/off choice.
      LEFT JOIN LATERAL (
        SELECT av.semver, e.pin_mode::text AS pin_mode FROM member_skill_enablements e
          JOIN registry_versions av ON av.id = e.version_id
         WHERE e.team_id = ${who.teamId} AND e.user_id = ${who.userId}
           AND e.catalog_skill_id = s.id AND e.enabled) ma ON true
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
                              WHERE st.skill_id = s.id AND t.name = ${query.tag}
                                AND t.kind = 'topic' AND t.status = 'active')`
           : sql``
       }
     ORDER BY ${order}
     LIMIT ${CATALOG_LIMIT}`);
  return res.rows;
}

function toCard(r: CardRow, usageOf: UsageOf): CatalogCard {
  const usage = usageOf(r.id);
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
    teamsInstalled: usage.teamsInstalled,
    usage: { members: usage.members, thumbsUp: usage.thumbsUp },
    state: {
      installed: r.pin_mode
        ? { semver: r.install_semver, pinMode: r.pin_mode, access: r.access ?? "available" }
        : null,
      addedByMe: r.added_by_me,
      myAdd:
        r.add_semver && r.add_pin_mode ? { semver: r.add_semver, pinMode: r.add_pin_mode } : null,
      blocked: r.blocked,
    },
  };
}

const rank = (t: number | "few") => (t === "few" ? 1 : t);

export interface CatalogPage {
  readonly skills: readonly CatalogCard[];
  /** Every active topic tag, for the filter. */
  readonly tags: readonly string[];
  /** The team switch "Members may add catalog skills for themselves" (KOBE-338, SK25). */
  readonly membersMayAdd: boolean;
  /** The fixed window the usage numbers cover (the last 30 finished UTC days, KOBE-339). */
  readonly usageWindow: { readonly from: string; readonly to: string };
}

export async function browseCatalog(
  db: KobeDb,
  who: { readonly teamId: string; readonly userId: string },
  query: CatalogQuery,
): Promise<CatalogPage> {
  const usageOf = await usageFor(db, who);
  const ids = await db.execute<{ id: string }>(sql`SELECT id FROM registry_skills`);
  const ranks = new Map(ids.rows.map((r) => [r.id, rank(usageOf(r.id).teamsInstalled)]));
  const { rows, membersMayAdd } = await withTeam(db, who.teamId, async (tx) => ({
    rows: await cardRows(tx, who, query, undefined, ranks),
    membersMayAdd: (await readCatalogSwitches(tx, who.teamId)).membersMayAdd,
  }));
  const sorted = rows.map((r) => toCard(r, usageOf));
  const tags = await db.execute<{ name: string }>(sql`
    SELECT name FROM registry_tags WHERE kind = 'topic' AND status = 'active' ORDER BY name`);
  return {
    skills: sorted,
    tags: tags.rows.map((t) => t.name),
    membersMayAdd,
    usageWindow: usageOf.window,
  };
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
  /** The caller may ask the Team admins for a host (D28 needs `team.chat`, review-336 L3). */
  readonly canRequestEgress: boolean;
  /** The team switch "Members may add catalog skills for themselves" (KOBE-338). */
  readonly membersMayAdd: boolean;
  /** The caller may block the skill in this team (Team admins). */
  readonly canBlock: boolean;
  /** A deprecated skill's replacement (KOBE-340). */
  readonly replacement: { readonly id: string; readonly name: string } | null;
  /** The caller may deprecate the skill or a version: an active maintainer or a Site admin. */
  readonly canDeprecate: boolean;
  /** The fixed window the usage numbers cover (KOBE-339). */
  readonly usageWindow: { readonly from: string; readonly to: string };
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
    SELECT id, semver,
      CASE WHEN suspended_at IS NOT NULL THEN 'suspended' ELSE state::text END AS state,
      approved_at, manifest, verdict::text AS verdict
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
  // Versions are immutable: one read and unzip per package (review-336 L1).
  const key = `${v.runtime_hash}:${v.package_hash}`;
  const cached = filesCache.get(key);
  if (cached) return cached;
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
  const out = { skillMd: md ? skillMdBody(new TextDecoder().decode(md)) : null, files };
  if (runtime && pkg) {
    if (filesCache.size >= FILES_CACHE_MAX)
      filesCache.delete(filesCache.keys().next().value as string);
    filesCache.set(key, out);
  }
  return out;
}

const filesCache = new Map<
  string,
  { skillMd: string | null; files: { path: string; size: number }[] }
>();
const FILES_CACHE_MAX = 100;

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
  who: {
    readonly teamId: string;
    readonly userId: string;
    readonly role: TeamRole;
    readonly siteRole?: SiteRole;
  },
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
      hosts,
      agents: await agentsUsing(tx, who.teamId, row.name),
      membersMayAdd: (await readCatalogSwitches(tx, who.teamId)).membersMayAdd,
    };
  });
  if (!found) return null;
  const { row, manifest } = found;
  const usageOf = await usageFor(db, who);
  const card = toCard(row, usageOf);
  const maintainers = await db.execute<{ name: string }>(sql`
    SELECT u.name FROM registry_maintainers m JOIN users u ON u.id = m.user_id
     WHERE m.skill_id = ${skillId} AND u.deactivated_at IS NULL ORDER BY u.name`);
  const { skillMd, files } = await versionFiles(db, blobs, row.version_id);
  // An allowlist (review-336 L2): only the catalog card's own fields, as its schema parses them.
  const { rerun: _rerun, ...cardOnly } = row.authoritative_scorecard ?? {};
  const parsed = row.authoritative_scorecard
    ? catalogSkillEvalScorecardSchema.safeParse(cardOnly)
    : null;
  const authoritative = parsed?.success ? (parsed.data as Record<string, unknown>) : null;
  return {
    ...card,
    skillMd,
    files,
    versions: await versionsOf(db, skillId),
    authoritativeScorecard: authoritative,
    license: typeof manifest.license === "string" ? manifest.license : null,
    egress: await hostStandings(db, who.teamId, found.hosts),
    packages: found.packages,
    maintainers: maintainers.rows.map((r) => r.name),
    agents: found.agents,
    canRequestEgress: teamRoleAllows(who.role, "team.chat"),
    membersMayAdd: found.membersMayAdd,
    canBlock: teamRoleAllows(who.role, "team.skills.installs.manage"),
    replacement: (await skillStanding(db, skillId)).replacement,
    canDeprecate:
      (who.siteRole !== undefined && siteRoleAllows(who.siteRole, "site.skills.catalog.manage")) ||
      (
        await db.execute(sql`
          SELECT 1 FROM registry_maintainers m JOIN users u ON u.id = m.user_id
           WHERE m.skill_id = ${skillId} AND m.user_id = ${who.userId}
             AND u.deactivated_at IS NULL`)
      ).rows.length > 0,
    usageWindow: usageOf.window,
  };
}
