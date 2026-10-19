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
