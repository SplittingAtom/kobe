import { z } from "zod";
import {
  commitConflictErrorSchema,
  commitProjectRequestSchema,
  commitProjectResponseSchema,
  projectCheckoutSchema,
  projectCheckoutsResponseSchema,
  projectCommitDetailSchema,
  projectDiffEntrySchema,
  projectHistoryResponseSchema,
  projectQuotaErrorSchema,
  revertProjectRequestSchema,
  updateCheckoutResponseSchema,
} from "@kobe/protocol";
import { storageSettingsSchema } from "../projects/storage.js";

/**
 * OpenAPI for project checkouts, commits, history and revert (KOBE-579, Workspaces CM2-CM7,
 * `routes/project-commits.ts`), the caller's checkouts and the workspace storage view (GV2, GV3).
 * Generated from the zod schemas of the contract (`packages/protocol/src/project-commits.ts`).
 */

type JsonSchema = Record<string, unknown>;

const schema = (s: z.ZodType, io: "input" | "output" = "output"): JsonSchema => {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(s, {
    io,
    target: "draft-2020-12",
    unrepresentable: "any",
  }) as JsonSchema;
  return rest;
};

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (name: string, description: string) => ({
  description,
  content: { "application/json": { schema: ref(name) } },
});
const body = (name: string) => ({
  required: true,
  content: { "application/json": { schema: ref(name) } },
});
const id = { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } };
const seq = { name: "seq", in: "path", required: true, schema: { type: "integer", minimum: 1 } };
const team = {
  name: "X-Kobe-Team",
  in: "header",
  required: false,
  description: "The team the client believes is active; must match when sent.",
  schema: { type: "string", format: "uuid" },
};
const common = {
  "401": json("Error", "`unauthenticated`: no session."),
  "403": json("Error", "`not_a_team_member`, or `forbidden`: the project role doesn't allow it."),
  "404": json(
    "Error",
    "`not_found`: no such project, or a restricted one the caller may not view.",
  ),
};

const op = (
  operationId: string,
  summary: string,
  description: string,
  responses: Record<string, unknown>,
  extra: Record<string, unknown> = {},
  params: unknown[] = [id],
) => ({
  operationId,
  summary,
  description,
  parameters: [...params, team],
  ...extra,
  responses: { ...responses, ...common },
});

const commitAnswers = {
  "200": json("CommitProjectResult", "`committed {seq, commit_id}` or `nothing_to_commit`."),
  "409": json(
    "CommitConflict",
    "`commit_conflict {head_seq}` (Update first), `checkout_required`, `archived`, or `forbidden` under a legal hold.",
  ),
  "413": json("Error", "`file_too_large`."),
  "507": json("ProjectQuotaError", "`quota_exceeded {limit: bytes|objects}`."),
  "422": json("Error", "`invalid_input`: more than 500 files, a bad name, or a `.conflict-` copy."),
  "503": json("Error", "`storage_unavailable`, or `busy` (the working copy kept changing)."),
};

export function projectCommitsOpenApiPaths(): Record<string, Record<string, unknown>> {
  return {
    "/v1/projects/{id}/checkout": {
      post: op(
        "checkoutProject",
        "Check out a project (editor+)",
        "The caller's `projects/<slug>/` becomes writable: base = head; idempotent; mounts the project if it was not (MT1). Audited `project.checked_out`.",
        {
          "200": json("ProjectCheckout", "The checkout."),
          "409": json("Error", "`archived`."),
        },
      ),
      get: op(
        "getProjectCheckout",
        "The caller's checkout and its working-copy diff",
        "Changes of the caller's working copy against the checkout's base (added, modified, deleted, with sizes). 404 when the caller has no checkout.",
        { "200": json("ProjectCheckoutWithDiff", "The checkout and its diff.") },
      ),
      delete: op(
        "discardProjectCheckout",
        "Discard the caller's checkout",
        "Ends the checkout; the folder goes back to the head (server rows and tombstones) or is unmounted when no conversation keeps it (MT1). Audited `project.checkout_discarded`.",
        { "204": { description: "Discarded." } },
      ),
    },
    "/v1/projects/{id}/checkout/update": {
      post: op(
        "updateProjectCheckout",
        "Bring the head's changes into the working copy",
        "Untouched paths take the head's version; both-changed ones take the head's and keep the member's beside it as `<name>.conflict-<time><ext>` (listed as workspace paths). The base moves to the head.",
        {
          "200": json("UpdateCheckoutResult", "The new base and the conflict copies."),
          "409": json("Error", "`checkout_required`."),
        },
      ),
    },
    "/v1/projects/{id}/checkouts": {
      get: op(
        "listProjectCheckouts",
        "Working copies (owners, team admins)",
        "Who has a checkout of the project, since when, and its base.",
        { "200": json("ProjectCheckouts", "The checkouts.") },
      ),
    },
    "/v1/projects/{id}/commit": {
      post: op(
        "commitProject",
        "Commit the caller's working copy (editor+)",
        "Diffs the caller's live rows under `projects/<slug>/` against the checkout's base, copies new contents server-side (hash-verified) into the project, writes the commit and its tree, moves the base. Counts against the team byte quota and object budget, attributed to the project. Audited `project.committed`.",
        commitAnswers,
        { requestBody: body("CommitProjectBody") },
      ),
    },
    "/v1/projects/{id}/commits": {
      get: op(
        "listProjectCommits",
        "The project's history (readers)",
        "Newest first; pass `next_before` as `before` for older ones.",
        {
          "200": json("ProjectHistory", "A page of commits."),
          "400": json("Error", "`invalid_request`."),
        },
        {},
        [
          id,
          { name: "before", in: "query", required: false, schema: { type: "integer", minimum: 1 } },
          {
            name: "limit",
            in: "query",
            required: false,
            schema: { type: "integer", minimum: 1, maximum: 200 },
          },
        ],
      ),
    },
    "/v1/projects/{id}/commits/{seq}": {
      get: op(
        "getProjectCommit",
        "One commit: its tree and the diff to its parent",
        "404 `commit_not_found` for an unknown or pruned seq.",
        { "200": json("ProjectCommitDetail", "The commit.") },
        {},
        [id, seq],
      ),
    },
    "/v1/projects/{id}/commits/{seq}/files/{path}": {
      get: op(
        "downloadProjectFileAtCommit",
        "Download a file as it was at a commit",
        "`path` is the file's path in the project, each segment URL-encoded, slashes kept.",
        {
          "200": {
            description: "The bytes (attachment).",
            content: { "application/octet-stream": {} },
          },
        },
        {},
        [id, seq, { name: "path", in: "path", required: true, schema: { type: "string" } }],
      ),
    },
    "/v1/projects/{id}/commits/{seq}/revert": {
      post: op(
        "revertProject",
        "Revert to a commit (editor+)",
        "Writes a new commit whose tree is the tree at `seq` (history stays append-only). Audited `project.commit_reverted`.",
        commitAnswers,
        { requestBody: body("RevertProjectBody") },
        [id, seq],
      ),
    },
    "/v1/projects/{id}/download": {
      get: op(
        "downloadProjectHead",
        "The project's current files as a zip (GV5)",
        "Readers may download (they can read every file).",
        { "200": { description: "A zip.", content: { "application/zip": {} } } },
      ),
    },
    "/v1/me/checkouts": {
      get: op(
        "listMyCheckouts",
        "The caller's checkouts in the active workspace",
        "Empty list when none.",
        { "200": json("MyCheckouts", "The checkouts.") },
        {},
        [],
      ),
    },
    "/v1/team/storage": {
      get: op(
        "getTeamStorage",
        "Workspace storage (team admins)",
        "Bytes and objects in use, the limits in force, the history and mount settings, and figures per scratchspace and per project (live and history).",
        { "200": json("TeamStorage", "The storage view.") },
        {},
        [],
      ),
      put: op(
        "updateTeamStorage",
        "Change history retention, the mount cap or the object budget (team admins)",
        "Any subset of `history_keep`, `max_mounted_per_member`, `max_objects` (null = the site default). Audited `project.storage_settings_changed`.",
        {
          "200": json("TeamStorage", "The storage view after the change."),
          "400": json("Error", "`invalid_request`."),
        },
        { requestBody: body("TeamStorageSettings") },
        [],
      ),
    },
  };
}

const teamStorageSchema = z.strictObject({
  used_bytes: z.number().int(),
  used_objects: z.number().int(),
  quota_bytes: z.number().int().nullable(),
  max_objects: z.number().int().nullable(),
  default_quota_bytes: z.number().int(),
  default_max_objects: z.number().int(),
  live_bytes: z.number().int(),
  history_bytes: z.number().int(),
  live_objects: z.number().int(),
  history_objects: z.number().int(),
  history_keep: z.unknown(),
  history_max_commits: z.number().int(),
  max_mounted_per_member: z.number().int(),
  scratchspaces: z.array(
    z.strictObject({
      user_id: z.uuid(),
      live_bytes: z.number().int(),
      live_files: z.number().int(),
      objects: z.number().int(),
    }),
  ),
  projects: z.array(
    z.strictObject({
      project_id: z.uuid(),
      slug: z.string(),
      name: z.string(),
      commits: z.number().int(),
      live_bytes: z.number().int(),
      history_bytes: z.number().int(),
      live_objects: z.number().int(),
      history_objects: z.number().int(),
    }),
  ),
});

export function projectCommitsOpenApiSchemas(): Record<string, JsonSchema> {
  return {
    ProjectCheckout: schema(projectCheckoutSchema),
    ProjectCheckoutWithDiff: schema(
      projectCheckoutSchema.extend({ diff: z.array(projectDiffEntrySchema) }),
    ),
    ProjectCheckouts: schema(projectCheckoutsResponseSchema),
    MyCheckouts: schema(z.strictObject({ checkouts: z.array(projectCheckoutSchema) })),
    UpdateCheckoutResult: schema(updateCheckoutResponseSchema),
    CommitProjectBody: schema(commitProjectRequestSchema, "input"),
    CommitProjectResult: schema(commitProjectResponseSchema),
    CommitConflict: schema(commitConflictErrorSchema),
    ProjectQuotaError: schema(projectQuotaErrorSchema),
    ProjectHistory: schema(projectHistoryResponseSchema),
    ProjectCommitDetail: schema(projectCommitDetailSchema),
    RevertProjectBody: schema(revertProjectRequestSchema, "input"),
    TeamStorage: schema(teamStorageSchema),
    TeamStorageSettings: schema(storageSettingsSchema, "input"),
  };
}
