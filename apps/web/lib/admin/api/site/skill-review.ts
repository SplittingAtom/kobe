/**
 * Site console: the Registry review (`/v1/site/skills/registry`, KOBE-334, SK22, SK23). Skill
 * reviewers and Site admins read the queue and decide; the server checks each action. Responses
 * arrive camelized.
 */
import { apiRequest, type ApiResult } from "../../../api/client";

const BASE = "/v1/site/skills/registry";

export const QUEUE_FILTERS = [
  "open",
  "submitted",
  "in_review",
  "changes_requested",
  "approved",
  "rejected",
  "retracted",
  "all",
] as const;
export type QueueFilter = (typeof QUEUE_FILTERS)[number];

export type Bump = "new" | "major" | "minor" | "patch" | "older";

export interface Person {
  readonly id: string;
  readonly name: string;
}

export interface QueueItem {
  readonly id: string;
  readonly skill: { readonly id: string; readonly name: string };
  readonly semver: string;
  readonly previous: { readonly id: string; readonly semver: string } | null;
  readonly bump: Bump;
  readonly changedFiles: number | null;
  readonly state: string;
  readonly verdict: string;
  readonly submittedBy: Person | null;
  readonly submittedAt: string;
  readonly claimedBy: Person | null;
  readonly authoritativeScorecard: boolean;
  readonly selfApproved: boolean;
}

export interface DiffHunk {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly lines: readonly string[];
}

export interface FileDiff {
  readonly path: string;
  readonly status: "added" | "removed" | "changed" | "unchanged";
  readonly size: number;
  readonly binary: boolean;
  readonly notDiffed?: "too_large" | "too_different" | "skipped";
  readonly hunks: readonly DiffHunk[];
}

export interface VersionDiff {
  readonly against: { readonly id: string; readonly semver: string } | null;
  readonly files: readonly FileDiff[];
  readonly changedFiles: number;
  readonly truncated: boolean;
}

export interface Problem {
  readonly code: string;
  readonly message: string;
}

export interface ScanFinding {
  readonly category?: string;
  readonly rule?: string;
  readonly severity?: string;
  readonly file?: string;
  readonly line?: number;
  readonly message?: string;
}

/** One re-run of a version (KOBE-335): who started it, how it ended, its numbers. */
export interface RerunEntry {
  readonly evalRunId: string;
  readonly startedBy: Person | null;
  readonly startedAt: string;
  readonly status: string;
  readonly cancelledBy: Person | null;
  readonly progress: { readonly done: number; readonly total: number } | null;
  readonly passRate: number | null;
  readonly lift: number | null;
  readonly current: boolean;
  readonly lowerThanCurrent: boolean;
}

export interface RawFile {
  readonly path: string;
  readonly size: number;
  readonly text: string | null;
  readonly truncated: boolean;
}

/** A scan finding; a Caution one is acknowledged before Approve (SK32). */
export interface ReviewFinding {
  readonly key: string;
  readonly rule: string;
  readonly file: string;
  readonly line: number;
  readonly severity: "caution" | "block";
  readonly category: string | null;
  readonly acknowledged: { readonly by: Person; readonly at: string } | null;
}

export interface ReviewEvent {
  readonly action: string;
  readonly actor: Person | null;
  readonly note: string | null;
  readonly at: string;
}

export interface ChecklistItem {
  readonly id: string;
  readonly label: string;
}

export interface ReviewDetail {
  readonly id: string;
  readonly skill: {
    readonly id: string;
    readonly name: string;
    readonly status: string;
    readonly maintainers: readonly { readonly userId: string; readonly name: string }[];
  };
  readonly semver: string;
  readonly state: string;
  readonly previous: { readonly id: string; readonly semver: string } | null;
  readonly bump: Bump;
  readonly verdict: string;
  readonly scan: { readonly findings?: readonly ScanFinding[]; readonly rulesVersion?: string };
  readonly findings: readonly ReviewFinding[];
  readonly scorecard: Record<string, unknown> | null;
  readonly authoritativeScorecard: Record<string, unknown> | null;
  /** Every re-run in the Registry team, oldest first (KOBE-335). */
  readonly reruns: readonly RerunEntry[];
  readonly manifest: Record<string, unknown>;
  readonly capabilities: {
    readonly egress: readonly { readonly host: string; readonly inCeiling: boolean }[];
    readonly packages: Record<string, unknown>;
  };
  readonly provenance: Record<string, unknown>;
  readonly source: { readonly teamName: string | null; readonly scope?: string };
  readonly submittedBy: Person | null;
  readonly confirmedBy: Person | null;
  readonly submittedAt: string;
  readonly claimedBy: Person | null;
  readonly selfApproved: boolean;
  readonly similarNames: readonly string[];
  readonly checklist: readonly ChecklistItem[];
  readonly events: readonly ReviewEvent[];
  readonly approveProblems: readonly Problem[];
}

export type DecisionAction = "approve" | "request_changes" | "reject" | "reject_and_block";

export interface Decision {
  readonly action: DecisionAction;
  readonly note?: string;
  readonly checklist?: Readonly<Record<string, boolean>>;
}

export interface StateAnswer {
  readonly id: string;
  readonly state: string;
}

export function listQueue(filter: QueueFilter): Promise<ApiResult<{ items: QueueItem[] }>> {
  return apiRequest(`${BASE}?state=${filter}`);
}

export function getReview(id: string): Promise<ApiResult<ReviewDetail>> {
  return apiRequest(`${BASE}/${encodeURIComponent(id)}`);
}

export function getReviewDiff(id: string): Promise<ApiResult<VersionDiff>> {
  return apiRequest(`${BASE}/${encodeURIComponent(id)}/diff`);
}

export function claimVersion(id: string): Promise<ApiResult<StateAnswer>> {
  return apiRequest(`${BASE}/${encodeURIComponent(id)}/claim`, { method: "POST", json: {} });
}

export function releaseVersion(id: string): Promise<ApiResult<StateAnswer>> {
  return apiRequest(`${BASE}/${encodeURIComponent(id)}/claim`, { method: "DELETE" });
}

export function commentOn(id: string, note: string): Promise<ApiResult<StateAnswer>> {
  return apiRequest(`${BASE}/${encodeURIComponent(id)}/comments`, {
    method: "POST",
    json: { note },
  });
}

/** One file's diff on its own ("Load diff" for a skipped file, review-335 M2). */
export function getFileDiff(id: string, path: string): Promise<ApiResult<FileDiff>> {
  return apiRequest(`${BASE}/${encodeURIComponent(id)}/diff?path=${encodeURIComponent(path)}`);
}

/** A submitted file's text (to 1 MiB), for one too large or too different to diff. */
export function getRawFile(id: string, path: string): Promise<ApiResult<RawFile>> {
  return apiRequest(`${BASE}/${encodeURIComponent(id)}/file?path=${encodeURIComponent(path)}`);
}

/** Cancels one re-run; the history keeps it (review-335 M3). */
export function cancelRerun(
  id: string,
  evalRunId: string,
): Promise<ApiResult<{ evalRunId: string }>> {
  return apiRequest(
    `${BASE}/${encodeURIComponent(id)}/reruns/${encodeURIComponent(evalRunId)}/cancel`,
    { method: "POST", json: {} },
  );
}

/** Re-runs the version's evals in the Registry team with the Site judge (KOBE-335). */
export function rerunEvals(id: string): Promise<ApiResult<{ evalRunId: string }>> {
  return apiRequest(`${BASE}/${encodeURIComponent(id)}/rerun-evals`, { method: "POST", json: {} });
}

/** Acknowledges one Caution finding by its key (KOBE-334 review M1). */
export function acknowledgeFinding(
  id: string,
  finding: string,
): Promise<ApiResult<{ finding: string; acknowledged: boolean }>> {
  return apiRequest(`${BASE}/${encodeURIComponent(id)}/acknowledgements`, {
    method: "POST",
    json: { finding },
  });
}

export function decideVersion(id: string, decision: Decision): Promise<ApiResult<StateAnswer>> {
  return apiRequest(`${BASE}/${encodeURIComponent(id)}/decision`, {
    method: "POST",
    json: decision,
  });
}

/** Whether the Registry can approve at all (SK21): a Registry team exists. */
export function registryStatus(): Promise<ApiResult<{ ready: boolean }>> {
  return apiRequest(`${BASE}/status`);
}
