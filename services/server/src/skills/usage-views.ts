import { FEEDBACK_MIN_RATERS } from "@kobe/protocol";
import type { TeamUse, UsageSnapshot, UsageWindow } from "./usage-snapshot.js";

/**
 * Who sees which usage numbers (KOBE-339, SK26), from the last closed window's snapshot:
 * - **members** (catalog cards and detail): site-wide teams installed, members using it and the
 *   thumbs-up share;
 * - **Team admins**: also their own team's runs, members and thumbs, per skill and version;
 * - **maintainers and Site admins**: site-wide numbers per version and Default opt-out counts.
 *
 * The minimum-count rule for a cross-team number: at least {@link MIN_TEAMS} teams the viewer
 * doesn't belong to **now** (their teams read at request time, review M3) contribute, none of
 * them more than {@link MAX_SHARE} of what those teams contribute together (review L2), and for
 * thumbs at least {@link MIN_RATINGS} of their ratings. Otherwise the number reads "few", none
 * included. Subtracting what the viewer knows of their own teams still leaves three teams mixed,
 * none of them dominant.
 *
 * Own-team numbers (Team admins): runs and members show only with at least
 * {@link MIN_TEAM_MEMBERS} members other than the viewer behind them; thumbs need
 * {@link FEEDBACK_MIN_RATERS} raters other than the viewer (as KOBE-275).
 *
 * Breakdowns: a per-version column carries an "other" cell for everything no listed version
 * covers (runs that recorded no version, installs whose pin runs nothing; review L1), and is
 * withheld whole when any of its non-empty cells is "few", so no hidden cell is the total minus
 * the shown ones. Never a team name or id.
 */
export const MIN_TEAMS = 3;
export const MIN_RATINGS = 20;
export const MAX_SHARE = 0.8;
export const MIN_TEAM_MEMBERS = 3;
/** The per-version cell for everything no listed version covers. */
export const OTHER_VERSION = "other";

export type Shown = number | "few";

type Teams = ReadonlyMap<string, TeamUse>;
const NO_TEAMS: Teams = new Map();
type VersionFilter = (semver: string | null) => boolean;
const ALL: VersionFilter = () => true;

const sumWhere = (m: ReadonlyMap<string, number>, f: VersionFilter) =>
  [...m].reduce((a, [k, n]) => (f(k) ? a + n : a), 0);
const usersWhere = (m: ReadonlyMap<string, ReadonlySet<string>>, f: VersionFilter) => {
  const out = new Set<string>();
  for (const [k, set] of m) if (f(k)) for (const u of set) out.add(u);
  return out;
};

/**
 * The rule on per-team amounts (only teams with something): three teams outside the viewer's,
 * none over {@link MAX_SHARE} of their sum.
 */
function passes(amounts: ReadonlyMap<string, number>, viewer: ReadonlySet<string>): boolean {
  const others = [...amounts].filter(([t, n]) => n > 0 && !viewer.has(t)).map(([, n]) => n);
  if (others.length < MIN_TEAMS) return false;
  const total = others.reduce((a, b) => a + b, 0);
  return Math.max(...others) <= MAX_SHARE * total;
}

interface Metric {
  readonly raw: number;
  readonly shown: Shown;
}

function metric(amounts: Map<string, number>, value: number, viewer: ReadonlySet<string>): Metric {
  return { raw: value, shown: passes(amounts, viewer) ? value : "few" };
}

function teamsInstalled(teams: Teams, viewer: ReadonlySet<string>, f: VersionFilter): Metric {
  const amounts = new Map<string, number>();
  for (const [id, u] of teams) if (u.installed && f(u.running)) amounts.set(id, 1);
  return metric(amounts, amounts.size, viewer);
}

function members(teams: Teams, viewer: ReadonlySet<string>, f: VersionFilter): Metric {
  const amounts = new Map<string, number>();
  const all = new Set<string>();
  for (const [id, u] of teams) {
    const users = usersWhere(u.members, f);
    if (users.size > 0) amounts.set(id, users.size);
    for (const m of users) all.add(m);
  }
  return metric(amounts, all.size, viewer);
}

function runs(teams: Teams, viewer: ReadonlySet<string>, f: VersionFilter): Metric {
  const amounts = new Map<string, number>();
  for (const [id, u] of teams) {
    const n = sumWhere(u.runs, f);
    if (n > 0) amounts.set(id, n);
  }
  return metric(
    amounts,
    [...amounts.values()].reduce((a, b) => a + b, 0),
    viewer,
  );
}

/** The thumbs-up share (0–1, two decimals); `raw` is how many ratings it stands on. */
function thumbs(teams: Teams, viewer: ReadonlySet<string>, f: VersionFilter): Metric {
  const amounts = new Map<string, number>();
  let up = 0;
  let all = 0;
  for (const [id, u] of teams) {
    const n = sumWhere(u.up, f) + sumWhere(u.down, f);
    if (n === 0) continue;
    amounts.set(id, n);
    up += sumWhere(u.up, f);
    all += n;
  }
  const others = [...amounts].filter(([t]) => !viewer.has(t)).reduce((a, [, n]) => a + n, 0);
  const ok = passes(amounts, viewer) && others >= MIN_RATINGS;
  return { raw: all, shown: ok ? Math.round((up / all) * 100) / 100 : "few" };
}

function optOuts(teams: Teams, viewer: ReadonlySet<string>): Metric {
  const amounts = new Map<string, number>();
  for (const [id, u] of teams) if (u.optedOut) amounts.set(id, 1);
  return metric(amounts, amounts.size, viewer);
}

/** What every member sees on a catalog card and detail. */
export interface CardUsage {
  readonly teamsInstalled: Shown;
  readonly members: Shown;
  readonly thumbsUp: Shown;
  readonly window: UsageWindow;
}

export function cardUsage(
  s: UsageSnapshot,
  skillId: string,
  viewer: ReadonlySet<string>,
): CardUsage {
  const teams = s.skills.get(skillId) ?? NO_TEAMS;
  return {
    teamsInstalled: teamsInstalled(teams, viewer, ALL).shown,
    members: members(teams, viewer, ALL).shown,
    thumbsUp: thumbs(teams, viewer, ALL).shown,
    window: { from: s.from, to: s.to },
  };
}

/** Default opt-outs under the rule (the Site console, review M4). */
export function optOutCount(s: UsageSnapshot, skillId: string, viewer: ReadonlySet<string>): Shown {
  return optOuts(s.skills.get(skillId) ?? NO_TEAMS, viewer).shown;
}

/** A column, withheld (null) when any non-empty cell is "few". */
function column(cells: readonly Metric[]): Shown[] | null {
  return cells.some((c) => c.raw > 0 && c.shown === "few") ? null : cells.map((c) => c.shown);
}

/** Maintainers and Site admins: site-wide totals and per version, and Default opt-outs. */
export interface SiteSkillUsage {
  readonly totals: {
    readonly teamsInstalled: Shown;
    readonly members: Shown;
    readonly runs: Shown;
    readonly thumbsUp: Shown;
    readonly optOuts: Shown;
  };
  /** The listed versions, then {@link OTHER_VERSION}. */
  readonly versions: readonly string[];
  readonly perVersion: {
    readonly teamsRunning: readonly Shown[] | null;
    readonly members: readonly Shown[] | null;
    readonly runs: readonly Shown[] | null;
    readonly thumbsUp: readonly Shown[] | null;
  };
  readonly window: UsageWindow;
  readonly refreshedAt: string;
}

export function siteSkillUsage(
  s: UsageSnapshot,
  skillId: string,
  versions: readonly string[],
  viewer: ReadonlySet<string>,
): SiteSkillUsage {
  const teams = s.skills.get(skillId) ?? NO_TEAMS;
  const listed = new Set(versions);
  const filters: VersionFilter[] = [
    ...versions.map(
      (v): VersionFilter =>
        (x) =>
          x === v,
    ),
    (x) => x === null || !listed.has(x),
  ];
  const per = (f: (t: Teams, v: ReadonlySet<string>, filter: VersionFilter) => Metric) =>
    column(filters.map((filter) => f(teams, viewer, filter)));
  return {
    totals: {
      teamsInstalled: teamsInstalled(teams, viewer, ALL).shown,
      members: members(teams, viewer, ALL).shown,
      runs: runs(teams, viewer, ALL).shown,
      thumbsUp: thumbs(teams, viewer, ALL).shown,
      optOuts: optOuts(teams, viewer).shown,
    },
    versions: [...versions, OTHER_VERSION],
    perVersion: {
      teamsRunning: per(teamsInstalled),
      members: per(members),
      runs: per(runs),
      thumbsUp: per(thumbs),
    },
    window: { from: s.from, to: s.to },
    refreshedAt: s.computedAt,
  };
}

/** Own-team thumbs: up and down, or not enough raters other than the viewer. */
export type TeamThumbs =
  | { readonly enough: true; readonly up: number; readonly down: number }
  | { readonly enough: false };

function teamThumbs(u: TeamUse, viewerId: string, f: VersionFilter): TeamThumbs {
  const raters = usersWhere(u.raters, f);
  raters.delete(viewerId);
  if (raters.size < FEEDBACK_MIN_RATERS) return { enough: false };
  return { enough: true, up: sumWhere(u.up, f), down: sumWhere(u.down, f) };
}

/** Own-team runs and members: shown with three members other than the viewer behind them. */
function ownTeam(
  u: TeamUse,
  viewerId: string,
  f: VersionFilter,
): { runs: Metric; members: Metric } {
  const users = usersWhere(u.members, f);
  const others = [...users].filter((m) => m !== viewerId).length;
  const ok = others >= MIN_TEAM_MEMBERS;
  const n = sumWhere(u.runs, f);
  return {
    runs: { raw: n, shown: ok ? n : "few" },
    members: { raw: users.size, shown: ok ? users.size : "few" },
  };
}

export interface TeamVersionUsage {
  readonly semver: string;
  readonly runs: Shown;
  readonly members: Shown;
}

/** A Team admin's view of one catalog skill in their own team. */
export interface TeamSkillUsage {
  readonly skillId: string;
  readonly runs: Shown;
  readonly members: Shown;
  readonly thumbs: TeamThumbs;
  /** Per version (every version the window saw, "" when a run recorded none); null: withheld. */
  readonly versions: readonly TeamVersionUsage[] | null;
  /** Per version thumbs, withheld whole unless every rated version has enough raters. */
  readonly versionThumbs:
    readonly { readonly semver: string; readonly thumbs: TeamThumbs }[] | null;
}

export function teamSkillUsage(
  s: UsageSnapshot,
  teamId: string,
  viewerId: string,
): TeamSkillUsage[] {
  const out: TeamSkillUsage[] = [];
  for (const [skillId, teams] of s.skills) {
    const u = teams.get(teamId);
    if (!u || (!u.installed && u.runs.size === 0 && u.raters.size === 0)) continue;
    const total = ownTeam(u, viewerId, ALL);
    const semvers = [...u.runs.keys()].sort();
    const cells = semvers.map((v) => ({ semver: v, ...ownTeam(u, viewerId, (x) => x === v) }));
    const withheld = cells.some(
      (c) => (c.runs.raw > 0 && c.runs.shown === "few") || c.members.shown === "few",
    );
    const vt = [...u.raters.keys()]
      .sort()
      .map((v) => ({ semver: v, thumbs: teamThumbs(u, viewerId, (x) => x === v) }));
    out.push({
      skillId,
      runs: total.runs.shown,
      members: total.members.shown,
      thumbs: teamThumbs(u, viewerId, ALL),
      versions: withheld
        ? null
        : cells.map((c) => ({ semver: c.semver, runs: c.runs.shown, members: c.members.shown })),
      versionThumbs: vt.every((x) => x.thumbs.enough) ? vt : null,
    });
  }
  return out;
}
