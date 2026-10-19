import { FEEDBACK_MIN_RATERS } from "@kobe/protocol";
import type { TeamUse, UsageSnapshot } from "./usage-snapshot.js";

/**
 * Who sees which usage numbers (KOBE-339, SK26), from the nightly snapshot:
 * - **members** (catalog cards and detail): site-wide teams installed, members using it in the
 *   window, and the thumbs-up share;
 * - **Team admins**: also their own team's runs, members and thumbs, per skill and version;
 * - **maintainers and Site admins**: site-wide numbers per version and Default opt-out counts.
 *
 * The minimum-count rule: a cross-team number is shown only when at least {@link MIN_TEAMS} teams
 * the viewer doesn't belong to contribute to it (and, for thumbs, at least {@link MIN_RATINGS}
 * of their ratings); otherwise it reads "few", including none, so "few" can't be told from zero.
 * Counting only teams other than the viewer's means subtracting what the viewer knows of their
 * own teams still leaves at least {@link MIN_TEAMS} teams mixed together. A breakdown (per version)
 * is withheld whole when any of its non-empty cells is "few", so no hidden cell is the total minus
 * the others (as KOBE-275's totals). Own-team thumbs need {@link FEEDBACK_MIN_RATERS} raters other
 * than the viewer, as KOBE-275's. Never a team name or id; the window is fixed (no parameters).
 */
export const MIN_TEAMS = 3;
export const MIN_RATINGS = 20;

export type Shown = number | "few";

export interface UsageWindow {
  readonly from: string;
  readonly to: string;
}

/** The teams whose contributions the viewer could know: theirs, and the active one. */
export function viewerTeams(s: UsageSnapshot, userId: string, activeTeamId?: string): Set<string> {
  const teams = new Set(s.memberships.get(userId) ?? []);
  if (activeTeamId) teams.add(activeTeamId);
  return teams;
}

type Teams = ReadonlyMap<string, TeamUse>;
const NO_TEAMS: Teams = new Map();
const sum = (m: ReadonlyMap<string, number>, v?: string) =>
  v === undefined ? [...m.values()].reduce((a, b) => a + b, 0) : (m.get(v) ?? 0);

function rule(contributors: readonly string[], viewer: ReadonlySet<string>): boolean {
  return contributors.filter((t) => !viewer.has(t)).length >= MIN_TEAMS;
}

/** One metric over the teams, for all versions or one; `raw` is the unruled value. */
interface Metric {
  readonly raw: number;
  readonly shown: Shown;
}

function teamsInstalled(teams: Teams, viewer: ReadonlySet<string>, version?: string): Metric {
  const ids = [...teams]
    .filter(([, u]) => u.installed && (version === undefined || u.running === version))
    .map(([id]) => id);
  return { raw: ids.length, shown: rule(ids, viewer) ? ids.length : "few" };
}

function members(teams: Teams, viewer: ReadonlySet<string>, version?: string): Metric {
  const users = new Set<string>();
  const ids: string[] = [];
  for (const [id, u] of teams) {
    const sets = version === undefined ? [...u.members.values()] : [u.members.get(version)];
    for (const s of sets) for (const m of s ?? []) users.add(m);
    if (sets.some((s) => (s?.size ?? 0) > 0)) ids.push(id);
  }
  return { raw: users.size, shown: rule(ids, viewer) ? users.size : "few" };
}

function runs(teams: Teams, viewer: ReadonlySet<string>, version?: string): Metric {
  let n = 0;
  const ids: string[] = [];
  for (const [id, u] of teams) {
    const c = sum(u.runs, version);
    if (c > 0) ids.push(id);
    n += c;
  }
  return { raw: n, shown: rule(ids, viewer) ? n : "few" };
}

/** The thumbs-up share (0–1, two decimals) and how many ratings it stands on. */
function thumbs(teams: Teams, viewer: ReadonlySet<string>, version?: string): Metric {
  let up = 0;
  let all = 0;
  let others = 0;
  const ids: string[] = [];
  for (const [id, u] of teams) {
    const n = sum(u.up, version) + sum(u.down, version);
    if (n === 0) continue;
    ids.push(id);
    up += sum(u.up, version);
    all += n;
    if (!viewer.has(id)) others += n;
  }
  const ok = rule(ids, viewer) && others >= MIN_RATINGS;
  return { raw: all, shown: ok ? Math.round((up / all) * 100) / 100 : "few" };
}

function optOuts(teams: Teams, viewer: ReadonlySet<string>): Metric {
  const ids = [...teams].filter(([, u]) => u.optedOut).map(([id]) => id);
  return { raw: ids.length, shown: rule(ids, viewer) ? ids.length : "few" };
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
    teamsInstalled: teamsInstalled(teams, viewer).shown,
    members: members(teams, viewer).shown,
    thumbsUp: thumbs(teams, viewer).shown,
    window: { from: s.from, to: s.to },
  };
}

/** A per-version column, withheld (null) when any non-empty cell is "few". */
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
  const per = (f: (t: Teams, v: ReadonlySet<string>, version?: string) => Metric) =>
    column(versions.map((v) => f(teams, viewer, v)));
  return {
    totals: {
      teamsInstalled: teamsInstalled(teams, viewer).shown,
      members: members(teams, viewer).shown,
      runs: runs(teams, viewer).shown,
      thumbsUp: thumbs(teams, viewer).shown,
      optOuts: optOuts(teams, viewer).shown,
    },
    versions,
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

function teamThumbs(u: TeamUse, viewerId: string, version?: string): TeamThumbs {
  const raters = new Set<string>();
  const sets = version === undefined ? [...u.raters.values()] : [u.raters.get(version)];
  for (const set of sets) for (const r of set ?? []) if (r !== viewerId) raters.add(r);
  if (raters.size < FEEDBACK_MIN_RATERS) return { enough: false };
  return { enough: true, up: sum(u.up, version), down: sum(u.down, version) };
}

export interface TeamVersionUsage {
  readonly semver: string;
  readonly runs: number;
  readonly members: number;
}

/** A Team admin's view of one catalog skill in their own team. */
export interface TeamSkillUsage {
  readonly skillId: string;
  readonly runs: number;
  readonly members: number;
  readonly thumbs: TeamThumbs;
  readonly versions: readonly TeamVersionUsage[];
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
    const semvers = [...new Set([...u.runs.keys(), ...u.raters.keys()])].sort();
    const all = new Set<string>();
    for (const set of u.members.values()) for (const m of set) all.add(m);
    const vt = [...u.raters.keys()]
      .sort()
      .map((v) => ({ semver: v, thumbs: teamThumbs(u, viewerId, v) }));
    out.push({
      skillId,
      runs: sum(u.runs),
      members: all.size,
      thumbs: teamThumbs(u, viewerId),
      versions: semvers.map((v) => ({
        semver: v,
        runs: u.runs.get(v) ?? 0,
        members: u.members.get(v)?.size ?? 0,
      })),
      versionThumbs: vt.every((x) => x.thumbs.enough) ? vt : null,
    });
  }
  return out;
}
