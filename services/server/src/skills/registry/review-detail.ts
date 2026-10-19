import { sql, type KobeDb } from "@kobe/db";
import { listMaintainers, type Maintainer } from "./maintainers.js";
import { similarCatalogNames } from "./names-db.js";
import { approveProblems, confirmerOf, type Problem } from "./review-approve.js";
import { acknowledgements, findingKey, type Acknowledgement } from "./review-findings.js";
import { latestRerun, type RerunStatus } from "./rerun.js";
import {
  approvedVersion,
  bumpOf,
  personOf,
  reviewEvents,
  userNames,
  versionRow,
  type Bump,
  type Person,
  type ReviewEvent,
} from "./review-queue.js";

/**
 * Everything the review screen shows beside the diff (KOBE-334, SK23): the scan verdict and
 * findings, the submitted and authoritative scorecards (numbers only), capabilities against the
 * site egress ceiling, provenance and its source team, similar-name hints, maintainers, the
 * checklist and the history, and whether the caller may approve it now (and why not).
 */

/** SK23's checklist; a decision may record which items the reviewer ticked. */
export const REVIEW_CHECKLIST = [
  { id: "instructions_match", label: "The instructions match the description" },
  { id: "no_prerequisites", label: "No “run this prerequisite” steps" },
  { id: "scripts_explained", label: "Scripts are explained" },
  { id: "no_secrets", label: "No secrets" },
] as const;
export type ChecklistId = (typeof REVIEW_CHECKLIST)[number]["id"];

export interface EgressCapability {
  readonly host: string;
  /** In the site egress ceiling (D28): a team can enable it. */
  readonly inCeiling: boolean;
}

/** A scan finding with its key and, for a Caution one, its acknowledgement (review M1). */
export interface ReviewFinding {
  readonly key: string;
  readonly rule: string;
  readonly file: string;
  readonly line: number;
  readonly severity: string;
  readonly category: string | null;
  readonly acknowledged: Acknowledgement | null;
}

export interface ReviewDetail {
  readonly id: string;
  readonly skill: {
    readonly id: string;
    readonly name: string;
    readonly status: string;
    readonly maintainers: readonly Maintainer[];
  };
  readonly semver: string;
  readonly state: string;
  readonly previous: { readonly id: string; readonly semver: string } | null;
  readonly bump: Bump;
  readonly verdict: string;
  readonly scan: Record<string, unknown>;
  readonly findings: readonly ReviewFinding[];
  readonly scorecard: Record<string, unknown> | null;
  readonly authoritativeScorecard: Record<string, unknown> | null;
  /** The latest re-run in the Registry team (KOBE-335): state and progress only. */
  readonly rerun: RerunStatus | null;
  readonly manifest: Record<string, unknown>;
  readonly capabilities: {
    readonly egress: readonly EgressCapability[];
    readonly packages: Record<string, unknown>;
  };
  readonly provenance: Record<string, unknown>;
  readonly source: Record<string, unknown> & { readonly teamName: string | null };
  readonly submittedBy: Person | null;
  readonly confirmedBy: Person | null;
  readonly submittedAt: string;
  readonly claimedBy: Person | null;
  readonly selfApproved: boolean;
  readonly similarNames: readonly string[];
  readonly checklist: typeof REVIEW_CHECKLIST;
  readonly events: readonly ReviewEvent[];
  /** Why the caller can't approve now (empty: Approve is open to them). */
  readonly approveProblems: readonly Problem[];
}

function capabilitiesOf(manifest: Record<string, unknown>) {
  const caps = (manifest.capabilities ?? {}) as { egress?: unknown; packages?: unknown };
  const egress = Array.isArray(caps.egress)
    ? caps.egress.filter((h): h is string => typeof h === "string")
    : [];
  const packages =
    caps.packages && typeof caps.packages === "object"
      ? (caps.packages as Record<string, unknown>)
      : {};
  return { egress, packages };
}

async function inCeiling(db: KobeDb, hosts: readonly string[]): Promise<Set<string>> {
  if (hosts.length === 0) return new Set();
  const res = await db.execute<{ domain: string }>(sql`
    SELECT domain FROM egress_domains WHERE in_ceiling
       AND domain IN (${sql.join(
         hosts.map((h) => sql`${h}`),
         sql`, `,
       )})`);
  return new Set(res.rows.map((r) => r.domain));
}

async function findingsOf(db: KobeDb, v: { id: string; scan: Record<string, unknown> }) {
  const raw = Array.isArray(v.scan.findings) ? (v.scan.findings as Record<string, unknown>[]) : [];
  const acks = await acknowledgements(db, v.id);
  return raw.map((f): ReviewFinding => {
    const key = findingKey(f);
    const severity = f.severity === "block" ? "block" : "caution";
    return {
      key,
      rule: String(f.rule ?? ""),
      file: String(f.file ?? ""),
      line: Number(f.line ?? 0),
      severity,
      category: typeof f.category === "string" ? f.category : null,
      acknowledged: severity === "caution" ? (acks.get(key) ?? null) : null,
    };
  });
}

async function teamName(db: KobeDb, teamId: unknown): Promise<string | null> {
  if (typeof teamId !== "string") return null;
  const res = await db.execute<{ name: string }>(sql`SELECT name FROM teams WHERE id = ${teamId}`);
  return res.rows[0]?.name ?? null;
}

export async function reviewDetail(
  db: KobeDb,
  versionId: string,
  callerId: string,
): Promise<ReviewDetail | null> {
  const v = await versionRow(db, versionId);
  if (!v || v.publisher !== "maintainer") return null;
  const approved = await approvedVersion(db, v.skillId, v.id);
  const caps = capabilitiesOf(v.manifest);
  const ceiling = await inCeiling(db, caps.egress);
  const confirmer = confirmerOf(v);
  const who = await userNames(db, [v.submittedBy, v.claimedBy, confirmer]);
  // Read-only, in a transaction of its own: the separation-of-duties check takes the site
  // admin-set lock for its answer, released at once.
  const { problems } = await db.transaction((tx) => approveProblems(tx, v, callerId));
  return {
    id: v.id,
    skill: {
      id: v.skillId,
      name: v.name,
      status: v.skillStatus,
      maintainers: await listMaintainers(db, v.skillId),
    },
    semver: v.semver,
    state: v.state,
    previous: approved ? { id: approved.id, semver: approved.semver } : null,
    bump: bumpOf(approved?.semver ?? null, v.semver),
    verdict: v.verdict,
    scan: v.scan,
    findings: await findingsOf(db, v),
    scorecard: v.scorecard,
    authoritativeScorecard: v.authoritativeScorecard,
    rerun: await latestRerun(db, v.id),
    manifest: v.manifest,
    capabilities: {
      egress: caps.egress.map((host) => ({ host, inCeiling: ceiling.has(host) })),
      packages: caps.packages,
    },
    provenance: v.provenance,
    source: { ...v.source, teamName: await teamName(db, v.source.teamId) },
    submittedBy: personOf(who, v.submittedBy),
    confirmedBy: personOf(who, confirmer),
    submittedAt: new Date(v.submittedAt).toISOString(),
    claimedBy: personOf(who, v.claimedBy),
    selfApproved: v.selfApproved,
    similarNames: await similarCatalogNames(db, v.name),
    checklist: REVIEW_CHECKLIST,
    events: await reviewEvents(db, v.id),
    approveProblems: problems,
  };
}
