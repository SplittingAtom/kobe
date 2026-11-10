import { z } from "zod";
import { idSchema, uuidSchema, timestampSchema } from "./common.js";
import { sha256HexSchema, workspacePathSchema } from "./sandbox-wire/workspace-sync.js";

/**
 * Project commits contract (KOBE-576, Workspaces WS-1; docs/specs/workspaces.md CM1-CM7, GV2-GV4).
 * Additive and strict. A project's files are a tree with a history of commits: a snapshot tree per
 * commit (`project_tree_entries`), a per-member checkout that records the commit it started from,
 * and server-side commit, update, discard and revert. The routes live in WS-4 (KOBE-579); this
 * file only fixes the shapes.
 */

/** Longest commit message (CM1), in characters. */
export const PROJECT_COMMIT_MESSAGE_MAX = 500;
/** Default hard cap of commits kept per project (GV3); older ones are pruned. */
export const PROJECT_HISTORY_MAX_COMMITS = 1000;
/** Default most projects mounted in one member's scratchspace (MT3); a workspace setting may change it. */
export const PROJECT_MOUNTS_MAX_PER_MEMBER = 20;
/** Page size bounds of the history list. */
export const PROJECT_HISTORY_PAGE_DEFAULT = 50;
export const PROJECT_HISTORY_PAGE_MAX = 200;

/**
 * Team audit events of the workspaces lane (GV4); packages/db defines them in KOBE-577.
 * `project.visibility_changed` is retired (KOBE-587): no longer written, old rows stay.
 */
export const PROJECT_AUDIT_EVENTS = [
  "project.owner_transferred",
  "project.checked_out",
  "project.checkout_discarded",
  "project.committed",
  "project.commit_reverted",
  "project.history_pruned",
] as const;
export type ProjectAuditEvent = (typeof PROJECT_AUDIT_EVENTS)[number];

/**
 * Error codes this file adds to the project API (`quota_exceeded` and `read_only` already exist in
 * `PROJECT_ERROR_CODES`). HTTP status in brackets, informative.
 */
export const PROJECT_COMMIT_ERROR_CODES = [
  "commit_conflict", // 409 the head moved since the checkout's base: run Update first
  "nothing_to_commit", // 200 as a status, never an error on the REST route; kept for the wire
  "too_many_mounts", // 409 the member's mounted-project cap (MT3)
  "checkout_required", // 409 a write inside a project folder without a checkout
  "commit_not_found", // 404 no such seq in this project (also once pruned)
  "proposal_not_found", // 404 no such proposal in that thread (or its run was compacted)
  "proposal_stale", // 409 the file changed in the project after the agent proposed the edit
  "proposal_not_allowed", // 409 the proposal can no longer be accepted (see its reason)
] as const;
export const projectCommitErrorCodeSchema = z.enum(PROJECT_COMMIT_ERROR_CODES);
export type ProjectCommitErrorCode = z.infer<typeof projectCommitErrorCodeSchema>;

const messageSchema = z.string().trim().min(1).max(PROJECT_COMMIT_MESSAGE_MAX);
const seqSchema = z.number().int().positive();
const countSchema = z.number().int().nonnegative();

/** `quota_exceeded` says which limit was hit (GV2). */
export const PROJECT_QUOTA_LIMITS = ["bytes", "objects"] as const;
export const projectQuotaLimitSchema = z.enum(PROJECT_QUOTA_LIMITS);
export const projectQuotaErrorSchema = z.strictObject({
  code: z.literal("quota_exceeded"),
  message: z.string().max(2000),
  limit: projectQuotaLimitSchema,
});
export type ProjectQuotaError = z.infer<typeof projectQuotaErrorSchema>;

/** 409 body of a commit whose base is behind the head. */
export const commitConflictErrorSchema = z.strictObject({
  code: z.literal("commit_conflict"),
  message: z.string().max(2000),
  head_seq: seqSchema,
});
export type CommitConflictError = z.infer<typeof commitConflictErrorSchema>;

/** 409 body of a project conversation refused by the mount cap. */
export const tooManyMountsErrorSchema = z.strictObject({
  code: z.literal("too_many_mounts"),
  message: z.string().max(2000),
  limit: z.number().int().positive(),
});
export type TooManyMountsError = z.infer<typeof tooManyMountsErrorSchema>;

// ----------------------------------------------------------------------------- records

export const PROJECT_COMMIT_AUTHOR_KINDS = ["user", "agent"] as const;

/** One commit (CM1). `seq` is 1, 2, 3... per project; `parent_id` null for the first. */
export const projectCommitSchema = z.strictObject({
  id: uuidSchema,
  project_id: uuidSchema,
  seq: seqSchema,
  parent_id: uuidSchema.nullable(),
  author_user_id: uuidSchema,
  author_kind: z.enum(PROJECT_COMMIT_AUTHOR_KINDS),
  thread_id: uuidSchema.nullable(),
  run_id: uuidSchema.nullable(),
  message: messageSchema,
  file_count: countSchema,
  bytes: countSchema,
  created_at: timestampSchema,
});
export type ProjectCommit = z.infer<typeof projectCommitSchema>;

/** One file of a commit's snapshot tree (CM1). */
export const projectTreeEntrySchema = z.strictObject({
  path: workspacePathSchema,
  sha256: sha256HexSchema,
  /** Opaque storage reference, never a URL or a credential. */
  blob_ref: z.string().min(1).max(512),
  size_bytes: countSchema,
  mime_type: z.string().min(1).max(255),
  executable: z.boolean(),
});
export type ProjectTreeEntry = z.infer<typeof projectTreeEntrySchema>;

/** A member's checkout of a project (CM2): the commit the working copy started from. */
export const projectCheckoutSchema = z.strictObject({
  project_id: uuidSchema,
  slug: z
    .string()
    .max(40)
    .regex(/^[a-z0-9][a-z0-9-]*$/, "invalid project slug"),
  /** Null when the project had no commit when it was checked out. */
  base_commit_id: uuidSchema.nullable(),
  base_commit_seq: seqSchema.nullable(),
  created_at: timestampSchema,
  updated_at: timestampSchema,
});
export type ProjectCheckout = z.infer<typeof projectCheckoutSchema>;

// ----------------------------------------------------------------------------- checkout, commit

/** `POST /v1/projects/:id/checkout` (editor+, idempotent) -> 200 {@link projectCheckoutSchema}. Empty body. */
export const checkoutProjectRequestSchema = z.strictObject({});
export type CheckoutProjectRequest = z.infer<typeof checkoutProjectRequestSchema>;

/** `GET /v1/projects/:id/checkouts` (owners, admins: "Working copies") -> list with the member. */
export const projectCheckoutsResponseSchema = z.strictObject({
  checkouts: z.array(projectCheckoutSchema.extend({ user_id: uuidSchema })),
});
export type ProjectCheckoutsResponse = z.infer<typeof projectCheckoutsResponseSchema>;

/** `POST /v1/projects/:id/commit` (editor+). */
export const commitProjectRequestSchema = z.strictObject({ message: messageSchema });
export type CommitProjectRequest = z.infer<typeof commitProjectRequestSchema>;

/**
 * 200 answers of commit and revert. A conflict is the 409 {@link commitConflictErrorSchema}, a
 * quota refusal the 413 {@link projectQuotaErrorSchema}.
 */
export const commitProjectResponseSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("committed"), seq: seqSchema, commit_id: uuidSchema }),
  z.strictObject({ status: z.literal("nothing_to_commit") }),
]);
export type CommitProjectResponse = z.infer<typeof commitProjectResponseSchema>;

// ----------------------------------------------------------------------------- accept a proposal

/**
 * `POST /v1/projects/:id/commits/from-proposal` (KOBE-591, projects-in-conversations PE4-PE6): the
 * thread's owner accepts an agent's `propose_file_edit` for a file of the conversation's project;
 * the server commits exactly the recorded content (never content from the request) as the head
 * tree with that one file replaced or added. `message` (the edited commit message) defaults to
 * the proposal's summary. Idempotent on `proposal_id`: a second accept answers the same commit.
 */
export const commitFromProposalRequestSchema = z.strictObject({
  thread_id: uuidSchema,
  proposal_id: uuidSchema,
  message: messageSchema.optional(),
});
export type CommitFromProposalRequest = z.infer<typeof commitFromProposalRequestSchema>;

export const commitFromProposalResponseSchema = z.strictObject({
  status: z.literal("committed"),
  seq: seqSchema,
  commit_id: uuidSchema,
});
export type CommitFromProposalResponse = z.infer<typeof commitFromProposalResponseSchema>;

/** 409: the file at the head is no longer the proposal's base (or a new file now exists). */
export const proposalStaleErrorSchema = z.strictObject({
  code: z.literal("proposal_stale"),
  message: z.string().max(2000),
  head_seq: seqSchema,
});
export type ProposalStaleError = z.infer<typeof proposalStaleErrorSchema>;

/**
 * Why a proposal can no longer be accepted (PE5): the conversation `moved` to another project (or
 * out of it), the member has `no_edit_access` now, the project is `archived`, or the proposal is
 * for the member's own files (`not_a_project_proposal`: accepted with the save route instead).
 */
export const PROPOSAL_NOT_ALLOWED_REASONS = [
  "moved",
  "no_edit_access",
  "archived",
  "not_a_project_proposal",
] as const;
export const proposalNotAllowedErrorSchema = z.strictObject({
  code: z.literal("proposal_not_allowed"),
  message: z.string().max(2000),
  reason: z.enum(PROPOSAL_NOT_ALLOWED_REASONS),
});
export type ProposalNotAllowedError = z.infer<typeof proposalNotAllowedErrorSchema>;

/**
 * `POST /v1/projects/:id/checkout/update` -> 200. The head's version takes a path both sides
 * changed and the member's edit stays beside it as `<name>.conflict-<time><ext>` (D13); those
 * paths are listed. The base moves to the head.
 */
export const updateCheckoutResponseSchema = z.strictObject({
  base_commit_seq: seqSchema.nullable(),
  conflict_paths: z.array(workspacePathSchema).max(500),
});
export type UpdateCheckoutResponse = z.infer<typeof updateCheckoutResponseSchema>;

/** `DELETE /v1/projects/:id/checkout` -> 204, no body (discard). */

// ----------------------------------------------------------------------------- history, diff, revert

/** `GET /v1/projects/:id/commits?before=&limit=`: `before` is a seq, newest first below it. */
export const projectHistoryQuerySchema = z.strictObject({
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(PROJECT_HISTORY_PAGE_MAX).optional(),
});
export type ProjectHistoryQuery = z.infer<typeof projectHistoryQuerySchema>;

export const projectHistoryResponseSchema = z.strictObject({
  commits: z.array(projectCommitSchema).max(PROJECT_HISTORY_PAGE_MAX),
  /** Pass as `before` for the next page; null = no older commit. */
  next_before: seqSchema.nullable(),
});
export type ProjectHistoryResponse = z.infer<typeof projectHistoryResponseSchema>;

export const projectDiffEntrySchema = z.discriminatedUnion("change", [
  z.strictObject({
    change: z.literal("added"),
    path: workspacePathSchema,
    size_bytes: countSchema,
  }),
  z.strictObject({
    change: z.literal("modified"),
    path: workspacePathSchema,
    size_bytes: countSchema,
    previous_size_bytes: countSchema,
  }),
  z.strictObject({
    change: z.literal("deleted"),
    path: workspacePathSchema,
    previous_size_bytes: countSchema,
  }),
]);
export type ProjectDiffEntry = z.infer<typeof projectDiffEntrySchema>;

/** `GET /v1/projects/:id/commits/:seq`: the commit, its tree and the diff to its parent. */
export const projectCommitDetailSchema = z.strictObject({
  commit: projectCommitSchema,
  tree: z.array(projectTreeEntrySchema).max(500),
  diff: z.array(projectDiffEntrySchema).max(1000),
});
export type ProjectCommitDetail = z.infer<typeof projectCommitDetailSchema>;

/**
 * `POST /v1/projects/:id/commits/:seq/revert` (editor+): a new commit whose tree is the tree at
 * `seq`; `message` absent = the server writes `Revert to #<seq>`. Answers like a commit.
 */
export const revertProjectRequestSchema = z.strictObject({ message: messageSchema.optional() });
export type RevertProjectRequest = z.infer<typeof revertProjectRequestSchema>;

// ----------------------------------------------------------------------------- agent commit (CM6)

/**
 * Model-facing input of `commit_project` (capability `projects`, registered only when
 * `run.start.project.access` is `write`). The project is the thread's own and the files are the
 * working copy the agent just pushed; neither is chosen by the model.
 */
export const commitProjectToolInputSchema = z.strictObject({ message: messageSchema });
export type CommitProjectToolInput = z.infer<typeof commitProjectToolInputSchema>;

/**
 * What the server answers an agent commit (CM6). `pending_approval`: the signed approval is open
 * and the commit happens when it is granted, over the same canonical input.
 */
export const projectCommitOutcomeSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("committed"), seq: seqSchema }),
  z.strictObject({ status: z.literal("commit_conflict"), head_seq: seqSchema }),
  z.strictObject({ status: z.literal("nothing_to_commit") }),
  z.strictObject({ status: z.literal("pending_approval") }),
]);
export type ProjectCommitOutcome = z.infer<typeof projectCommitOutcomeSchema>;

/** Open on the sandbox side (like `projectProposeErrorSchema`). */
export const projectCommitFailSchema = z.strictObject({
  code: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  message: z.string().max(2000),
});
export const projectCommitOkFields = {
  ok: z.literal(true),
  op: z.literal("project_commit"),
  outcome: projectCommitOutcomeSchema,
} as const;
export const projectCommitFailFields = {
  ok: z.literal(false),
  error: projectCommitFailSchema,
} as const;

/** kobe-tools request (fd 4); member of the tools request union. */
export const projectCommitToolsRequestSchema = z.strictObject({
  id: idSchema,
  op: z.literal("project.commit"),
  tool_call_id: idSchema,
  tool: z.literal("commit_project"),
  input: commitProjectToolInputSchema,
});
export type ProjectCommitToolsRequest = z.infer<typeof projectCommitToolsRequestSchema>;

// ----------------------------------------------------------------------------- list, owner transfer

/** `GET /v1/projects?role=editor&include_archived=` (PJ2): `role=editor` = only projects the caller may edit. */
export const listProjectsQuerySchema = z.strictObject({
  role: z.literal("editor").optional(),
  include_archived: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
});
export type ListProjectsQuery = z.infer<typeof listProjectsQuerySchema>;

/**
 * `POST /v1/projects/:id/owner` (PR5; owners and team admins) -> 200. The target must be in the
 * workspace; it becomes an owner. `previous_owner_user_id` is the caller when an owner handed
 * over (who stays an editor), null when a team admin assigned one.
 */
export const transferOwnerRequestSchema = z.strictObject({ user_id: uuidSchema });
export type TransferOwnerRequest = z.infer<typeof transferOwnerRequestSchema>;
export const transferOwnerResponseSchema = z.strictObject({
  project_id: uuidSchema,
  owner_user_id: uuidSchema,
  previous_owner_user_id: uuidSchema.nullable(),
});
export type TransferOwnerResponse = z.infer<typeof transferOwnerResponseSchema>;
