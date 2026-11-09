/**
 * Project checkouts, commits and history (Workspaces CM2-CM7, KOBE-581) over the shared client.
 * Shapes follow `packages/protocol/src/project-commits.ts` (KOBE-576), camelized by the client.
 * The routes are KOBE-579's; two are this ticket's reading of the spec where the protocol is
 * silent (the caller's own checkouts, and one checkout with its pending changes): see
 * docs/ledger/KOBE-581.md "Open for 579/582". The server decides; the UI only hides controls.
 */
import { apiDownload, apiRequest, type ApiResult } from "../api/client";

export interface ProjectCheckout {
  readonly projectId: string;
  readonly slug: string;
  /** Null when the project had no commit when it was checked out. */
  readonly baseCommitId: string | null;
  readonly baseCommitSeq: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type ProjectDiffEntry =
  | { readonly change: "added"; readonly path: string; readonly sizeBytes: number }
  | {
      readonly change: "modified";
      readonly path: string;
      readonly sizeBytes: number;
      readonly previousSizeBytes: number;
    }
  | { readonly change: "deleted"; readonly path: string; readonly previousSizeBytes: number };

/** The caller's checkout with what changed against its base ("Changes", CM8). */
export interface CheckoutState extends ProjectCheckout {
  readonly diff: readonly ProjectDiffEntry[];
}

export interface WorkingCopy extends ProjectCheckout {
  readonly userId: string;
}

export interface ProjectCommit {
  readonly id: string;
  readonly projectId: string;
  readonly seq: number;
  readonly parentId: string | null;
  readonly authorUserId: string;
  readonly authorKind: "user" | "agent";
  readonly threadId: string | null;
  readonly runId: string | null;
  readonly message: string;
  readonly fileCount: number;
  readonly bytes: number;
  readonly createdAt: string;
}

export interface ProjectTreeEntry {
  readonly path: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly mimeType: string;
  readonly executable: boolean;
}

export interface ProjectHistoryPage {
  readonly commits: readonly ProjectCommit[];
  readonly nextBefore: number | null;
}

export interface ProjectCommitDetail {
  readonly commit: ProjectCommit;
  readonly tree: readonly ProjectTreeEntry[];
  readonly diff: readonly ProjectDiffEntry[];
}

export type CommitResult =
  | { readonly status: "committed"; readonly seq: number; readonly commitId: string }
  | { readonly status: "nothing_to_commit" };

export interface UpdateResult {
  readonly baseCommitSeq: number | null;
  /** Paths both sides changed: the head's version took them, the member's edit sits beside. */
  readonly conflictPaths: readonly string[];
}

/** Longest commit message (CM1; `PROJECT_COMMIT_MESSAGE_MAX` in the protocol). */
export const COMMIT_MESSAGE_MAX = 500;

export interface ProjectCommitsApi {
  /** `POST /v1/projects/:id/checkout` (editor+, idempotent). */
  checkout(id: string): Promise<ApiResult<ProjectCheckout>>;
  /** `GET /v1/me/checkouts`: the caller's checkouts in the active workspace (the editing marks). */
  myCheckouts(): Promise<ApiResult<readonly ProjectCheckout[]>>;
  /** `GET /v1/projects/:id/checkout`: the caller's checkout and its diff; 404 = none. */
  checkoutState(id: string): Promise<ApiResult<CheckoutState | null>>;
  /** `DELETE /v1/projects/:id/checkout` (discard, 204). */
  discard(id: string): Promise<ApiResult<void>>;
  /** `POST /v1/projects/:id/commit`; 409 `commit_conflict` when the head moved on. */
  commit(id: string, message: string): Promise<ApiResult<CommitResult>>;
  /** `POST /v1/projects/:id/checkout/update`. */
  update(id: string): Promise<ApiResult<UpdateResult>>;
  /** `GET /v1/projects/:id/checkouts` (owners, admins: "Working copies"). */
  workingCopies(id: string): Promise<ApiResult<readonly WorkingCopy[]>>;
  history(id: string, before?: number | null): Promise<ApiResult<ProjectHistoryPage>>;
  commitDetail(id: string, seq: number): Promise<ApiResult<ProjectCommitDetail>>;
  /** A file as it was at commit `seq`. */
  downloadAt(id: string, seq: number, path: string): Promise<ApiResult<Uint8Array>>;
  /** A new commit whose tree is the tree at `seq` (editor+); answers like a commit. */
  revert(id: string, seq: number): Promise<ApiResult<CommitResult>>;
}

const enc = encodeURIComponent;
/** A path's segments each encoded, the slashes kept. */
const encPath = (path: string) => path.split("/").map(enc).join("/");

export function createCommitsApi(teamId: string, fetchFn?: typeof fetch): ProjectCommitsApi {
  const call = <T>(path: string, method: "GET" | "POST" | "DELETE" = "GET", json?: unknown) =>
    apiRequest<T>(path, { method, json, teamId, fetchFn });
  const base = (id: string) => `/v1/projects/${enc(id)}`;
  return {
    checkout: (id) => call(`${base(id)}/checkout`, "POST", {}),
    myCheckouts: async () => {
      const res = await call<{ checkouts: ProjectCheckout[] }>("/v1/me/checkouts");
      return res.ok ? { ...res, data: res.data.checkouts } : res;
    },
    checkoutState: async (id) => {
      const res = await call<CheckoutState>(`${base(id)}/checkout`);
      if (!res.ok && res.error.status === 404) return { ok: true, status: 404, data: null };
      return res;
    },
    discard: (id) => call(`${base(id)}/checkout`, "DELETE"),
    commit: (id, message) => call(`${base(id)}/commit`, "POST", { message }),
    update: (id) => call(`${base(id)}/checkout/update`, "POST", {}),
    workingCopies: async (id) => {
      const res = await call<{ checkouts: WorkingCopy[] }>(`${base(id)}/checkouts`);
      return res.ok ? { ...res, data: res.data.checkouts } : res;
    },
    history: (id, before) =>
      call(`${base(id)}/commits${before == null ? "" : `?before=${before}`}`),
    commitDetail: (id, seq) => call(`${base(id)}/commits/${seq}`),
    downloadAt: (id, seq, path) =>
      apiDownload(`${base(id)}/commits/${seq}/files/${encPath(path)}`, { teamId, fetchFn }),
    revert: (id, seq) => call(`${base(id)}/commits/${seq}/revert`, "POST", {}),
  };
}

/** The diff's size in words: "3 changes" (CM8 "Changes"). */
export function changesLabel(count: number): string {
  return count === 1 ? "1 change" : `${count} changes`;
}
