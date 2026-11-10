import { Readable } from "node:stream";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import { withTeam, type KobeTx } from "@kobe/db";
import {
  commitFromProposalRequestSchema,
  commitProjectRequestSchema,
  PROJECT_HISTORY_MAX_COMMITS,
  projectHistoryQuerySchema,
  revertProjectRequestSchema,
  workspacePathSchema,
} from "@kobe/protocol";
import { requireTeam, requireTeamPermission, type TeamVariables } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import { loadAccess, type ProjectAccess } from "../projects/access.js";
import {
  checkout,
  checkoutWithDiff,
  discard,
  findCheckout,
  myCheckouts,
  projectCheckouts,
  update,
} from "../projects/checkouts.js";
import {
  commitWorkingCopy,
  revertTo,
  type CommitDeps,
  type CommitResult,
} from "../projects/commits.js";
import { commitProposal, type ProposalResult } from "../projects/from-proposal.js";
import { commitDetail, fileAt, headZip, historyPage, servable } from "../projects/history.js";
import type { TreeFile } from "../projects/tree.js";
import { storageSettingsSchema, storageView, writeStorageSettings } from "../projects/storage.js";
import { logger } from "../logger.js";
import { invalidRequest, parseBody } from "../teams/http.js";
import { DEFAULT_TEAM_MAX_OBJECTS, DEFAULT_UPLOAD_SETTINGS } from "../uploads/settings.js";
import { attachmentDisposition } from "../workspace-files/paths.js";
import type { WorkspaceSync } from "../workspace-sync/service.js";

type Ctx = Context<{ Variables: TeamVariables }>;
type ProjectAction = "view" | "edit" | "manage";

const idParam = z.uuid();
const seqParam = z.coerce.number().int().positive().max(2_147_483_647);

const fail = (c: Ctx, status: number, code: string, message: string, extra: object = {}) =>
  c.json({ code, message, ...extra }, status as 400);

const notFound = (c: Ctx) =>
  fail(c, 404, "not_found", "No project with that id is available to you.");
const forbidden = (c: Ctx) => fail(c, 403, "forbidden", "Your project role doesn't allow that.");
const noStorage = (c: Ctx) =>
  fail(c, 503, "storage_unavailable", "File storage is not available. Try again.");

/** A commit or revert outcome as the REST contract answers it (`project-commits.ts`). */
function commitAnswer(c: Ctx, result: CommitResult | { status: "commit_not_found" }): Response {
  switch (result.status) {
    case "committed":
      return c.json({ status: "committed", seq: result.seq, commit_id: result.commitId });
    case "nothing_to_commit":
      return c.json({ status: "nothing_to_commit" });
    case "commit_conflict":
      return fail(
        c,
        409,
        "commit_conflict",
        `The project moved on to #${result.headSeq} since you checked it out. Update, then commit again.`,
        { head_seq: result.headSeq },
      );
    case "commit_not_found":
      return fail(c, 404, "commit_not_found", "No such commit in this project (or it was pruned).");
    case "refused":
      return refusal(c, result);
  }
}

function refusal(c: Ctx, r: Extract<CommitResult, { status: "refused" }>): Response {
  const named = r.path === undefined ? "" : ` (${r.path})`;
  switch (r.error) {
    case "not_found":
      return notFound(c);
    case "forbidden":
      return forbidden(c);
    case "checkout_required":
      return fail(c, 409, "checkout_required", "Check the project out first.");
    case "archived":
      return fail(c, 409, "archived", "The project is archived.");
    case "too_many_files":
      return fail(c, 422, "invalid_input", "A project holds at most 500 files.");
    case "file_too_large":
      return fail(c, 413, "file_too_large", `A file is larger than a project file may be${named}.`);
    case "conflict_file":
      return fail(
        c,
        422,
        "invalid_input",
        `Resolve the conflict copy first: keep what you need and delete it${named}.`,
      );
    case "invalid_path":
      return fail(c, 422, "invalid_input", `A file name can't be used in a project${named}.`);
    case "quota_exceeded":
      return fail(
        c,
        507,
        "quota_exceeded",
        r.limit === "objects"
          ? "The commit would pass your workspace's object budget."
          : "The commit would pass your workspace's storage quota.",
        { limit: r.limit ?? "bytes" },
      );
    case "legal_hold":
      return fail(c, 409, "forbidden", "The workspace is under a legal hold: its files stay.");
    case "changed":
      c.header("Retry-After", "2");
      return fail(c, 503, "busy", "Your working copy changed while committing. Try again.");
    case "storage_failed":
      return noStorage(c);
  }
}

const NOT_ALLOWED: Record<Extract<ProposalResult, { status: "not_allowed" }>["reason"], string> = {
  moved: "The conversation is no longer in this project, so the edit can't be committed here.",
  no_edit_access: "You can no longer edit this project, so the edit can't be committed.",
  archived: "The project is archived.",
  not_a_project_proposal: "This proposal is for your own files; save it there instead.",
};

/** An accepted proposal's outcome as the REST contract answers it (`project-commits.ts`). */
function proposalAnswer(c: Ctx, result: ProposalResult): Response {
  switch (result.status) {
    case "committed":
      return c.json({ status: "committed", seq: result.seq, commit_id: result.commitId });
    case "thread_not_found":
      return fail(c, 404, "thread_not_found", "No thread with that id.");
    case "proposal_not_found":
      return fail(c, 404, "proposal_not_found", "No such proposal in that conversation.");
    case "not_found":
      return notFound(c);
    case "stale":
      return fail(
        c,
        409,
        "proposal_stale",
        "This file changed after the agent proposed the edit. Ask it to propose again.",
        { head_seq: result.headSeq },
      );
    case "not_allowed":
      return fail(c, 409, "proposal_not_allowed", NOT_ALLOWED[result.reason], {
        reason: result.reason,
      });
    case "quota_exceeded":
      return refusal(c, { status: "refused", error: "quota_exceeded", limit: result.limit });
    case "refused":
      return refusal(c, { status: "refused", error: result.error });
  }
}

/**
 * Checkout, commit, update, discard, history and revert of a project (KOBE-579, Workspaces CM2-CM7;
 * contract `packages/protocol/src/project-commits.ts`), next to `routes/projects.ts` under
 * `/v1/projects`. Every route starts from `loadAccess` (every workspace member reads every project,
 * RV1; anyone else gets 404); readers read history, editors check out, commit and revert; owners and team admins
 * see the working copies.
 */
export function projectCommitRoutes(
  deps: ServerDeps,
  sync?: WorkspaceSync,
): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  const db = deps.database.db;
  app.use(requireTeam(deps));
  app.use(requireTeamPermission("team.read"));
  const owner = (c: Ctx) => ({ teamId: c.get("team").id, userId: c.get("user").id });
  const settings = () => deps.uploads ?? DEFAULT_UPLOAD_SETTINGS;
  const commitDeps = (): CommitDeps => ({
    db,
    blobs: deps.blobs,
    mounts: deps.projectMounts,
    limits: {
      quotaDefaultBytes: settings().defaultQuotaBytes,
      maxObjectsDefault: settings().defaultMaxObjects ?? DEFAULT_TEAM_MAX_OBJECTS,
      maxFileBytes: settings().maxFileBytes,
    },
    log: logger,
  });

  const withProject = async (
    c: Ctx,
    action: ProjectAction,
    fn: (tx: KobeTx, access: ProjectAccess) => Promise<Response>,
    lock = false,
  ): Promise<Response> => {
    const id = idParam.safeParse(c.req.param("id"));
    if (!id.success) return notFound(c);
    return withTeam(db, c.get("team").id, async (tx) => {
      const access = await loadAccess(tx, owner(c), id.data, { lock });
      if (!access) return notFound(c);
      if (!access.can[action]) return forbidden(c);
      return fn(tx, access);
    });
  };

  app.post("/:id/checkout", async (c) => {
    if (!sync) return noStorage(c);
    const res = await withProject(
      c,
      "edit",
      async (tx, access) => {
        const done = await checkout(tx, sync, owner(c), access.project);
        if (!done.ok) return fail(c, 409, "archived", "The project is archived.");
        return c.json(done.checkout, 200);
      },
      true,
    );
    return res;
  });

  app.get("/:id/checkout", (c) =>
    withProject(c, "view", async (tx, access) => {
      const found = await checkoutWithDiff(tx, owner(c), access.project.id);
      return found
        ? c.json(found)
        : fail(c, 404, "not_found", "You have no checkout of this project.");
    }),
  );

  app.delete("/:id/checkout", (c) =>
    // Anyone who still sees the project may end their own checkout (also after losing edit).
    withProject(
      c,
      "view",
      async (tx, access) => {
        const ended = await discard(tx, deps.projectMounts, owner(c), access.project.id);
        return ended
          ? c.body(null, 204)
          : fail(c, 404, "not_found", "You have no checkout of this project.");
      },
      true,
    ),
  );

  app.post("/:id/checkout/update", async (c) => {
    if (!sync) return noStorage(c);
    return withProject(
      c,
      "edit",
      async (tx, access) => {
        const row = await findCheckout(
          tx,
          access.project.teamId,
          access.project.id,
          owner(c).userId,
        );
        if (!row) return fail(c, 409, "checkout_required", "Check the project out first.");
        return c.json(await update(tx, sync, owner(c), access.project, row));
      },
      true,
    );
  });

  app.get("/:id/checkouts", (c) =>
    withProject(c, "manage", async (tx, access) =>
      c.json({ checkouts: await projectCheckouts(tx, access.project.teamId, access.project.id) }),
    ),
  );

  app.post("/:id/commit", async (c) => {
    const id = idParam.safeParse(c.req.param("id"));
    if (!id.success) return notFound(c);
    const body = await parseBody(c, commitProjectRequestSchema);
    if (!body) return invalidRequest(c, "Give a message (1 to 500 characters).");
    const viewer = owner(c);
    const result = await commitWorkingCopy(commitDeps(), {
      owner: viewer,
      projectId: id.data,
      message: body.message,
      author: { userId: viewer.userId, kind: "user" },
    });
    return commitAnswer(c, result);
  });

  /**
   * PE4-PE6 (KOBE-591): the thread's owner accepts an agent's proposal for a file of the
   * conversation's project; the recorded content is committed (never content from the request).
   */
  app.post("/:id/commits/from-proposal", async (c) => {
    const id = idParam.safeParse(c.req.param("id"));
    if (!id.success) return notFound(c);
    const body = await parseBody(c, commitFromProposalRequestSchema);
    if (!body) {
      return invalidRequest(
        c,
        "Give thread_id and proposal_id, and optionally a message (1 to 500 characters).",
      );
    }
    const result = await commitProposal(commitDeps(), {
      owner: owner(c),
      projectId: id.data,
      threadId: body.thread_id,
      proposalId: body.proposal_id,
      message: body.message,
    });
    return proposalAnswer(c, result);
  });

  app.get("/:id/commits", async (c) => {
    const query = projectHistoryQuerySchema.safeParse(c.req.query());
    if (!query.success) return invalidRequest(c, "before and limit must be positive integers.");
    return withProject(c, "view", async (tx, access) =>
      c.json(
        await historyPage(
          tx,
          access.project.teamId,
          access.project.id,
          query.data.before,
          query.data.limit,
        ),
      ),
    );
  });

  app.get("/:id/commits/:seq", (c) => {
    const seq = seqParam.safeParse(c.req.param("seq"));
    if (!seq.success) return Promise.resolve(commitAnswer(c, { status: "commit_not_found" }));
    return withProject(c, "view", async (tx, access) => {
      const detail = await commitDetail(tx, access.project.teamId, access.project.id, seq.data);
      return detail ? c.json(detail) : commitAnswer(c, { status: "commit_not_found" });
    });
  });

  app.get("/:id/commits/:seq/files/*", async (c) => {
    const seq = seqParam.safeParse(c.req.param("seq"));
    const marker = `/commits/${c.req.param("seq") ?? ""}/files/`;
    const raw = c.req.path.slice(c.req.path.indexOf(marker) + marker.length);
    let decoded: string;
    try {
      decoded = raw.split("/").map(decodeURIComponent).join("/");
    } catch {
      return invalidRequest(c, "That is not a valid file path.");
    }
    const path = workspacePathSchema.safeParse(decoded);
    if (!seq.success || !path.success) return invalidRequest(c, "That is not a valid file path.");
    const blobs = deps.blobs;
    if (!blobs) return noStorage(c);
    let file: TreeFile | undefined;
    const found = await withProject(c, "view", async (tx, access) => {
      file = await fileAt(tx, access.project.teamId, access.project.id, seq.data, path.data);
      if (!file || !servable(blobs, access.project.teamId, access.project.id, file.blobRef)) {
        return fail(c, 404, "not_found", "No such file at that commit.");
      }
      return c.body(null, 200);
    });
    if (found.status !== 200 || file === undefined) return found;
    const object = await blobs.objects.get(file.blobRef);
    if (!object)
      return fail(c, 502, "content_missing", "The file's content is missing in storage.");
    return new Response(Readable.toWeb(object.body) as ReadableStream, {
      status: 200,
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(file.size),
        "content-disposition": attachmentDisposition(file.path),
        "x-content-type-options": "nosniff",
        "cache-control": "private, no-store",
      },
    });
  });

  app.post("/:id/commits/:seq/revert", async (c) => {
    const id = idParam.safeParse(c.req.param("id"));
    const seq = seqParam.safeParse(c.req.param("seq"));
    if (!id.success) return notFound(c);
    if (!seq.success) return commitAnswer(c, { status: "commit_not_found" });
    const body = await parseBody(c, revertProjectRequestSchema);
    if (!body) return invalidRequest(c, "Optionally give a message (1 to 500 characters).");
    const result = await revertTo(
      { db, mounts: deps.projectMounts },
      owner(c),
      id.data,
      seq.data,
      body.message,
    );
    return commitAnswer(c, result);
  });

  /** GV5: the head as a zip (readers may download every file anyway). */
  app.get("/:id/download", async (c) => {
    const blobs = deps.blobs;
    if (!blobs) return noStorage(c);
    let slug = "";
    let projectId = "";
    const allowed = await withProject(c, "view", (_tx, access) => {
      slug = access.project.slug;
      projectId = access.project.id;
      return Promise.resolve(c.body(null, 200));
    });
    if (allowed.status !== 200) return allowed;
    const body = Readable.toWeb(
      Readable.from(headZip(db, blobs, c.get("team").id, projectId, slug)),
    ) as ReadableStream<Uint8Array>;
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": "application/zip",
        "content-disposition": attachmentDisposition(`${slug}.zip`),
        "cache-control": "private, no-store",
      },
    });
  });

  return app;
}

/** `GET /v1/me/checkouts`: the caller's checkouts in the active workspace (KOBE-579). */
export function myCheckoutRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  app.use(requireTeam(deps));
  app.use(requireTeamPermission("team.read"));
  app.get("/", async (c) => {
    const viewer = { teamId: c.get("team").id, userId: c.get("user").id };
    const list = await withTeam(deps.database.db, viewer.teamId, (tx) => myCheckouts(tx, viewer));
    return c.json({ checkouts: list });
  });
  return app;
}

/**
 * `GET/PUT /v1/team/storage` (team admins; KOBE-579, GV2, GV3, MT3): bytes and objects per
 * workspace, scratchspace and project, the limits in force, and the settings
 * `projects.history_keep`, `projects.max_mounted_per_member` and `max_objects` (audited).
 */
export function teamStorageRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  const db = deps.database.db;
  app.use(requireTeam(deps));
  app.use(requireTeamPermission("team.projects.manage"));
  const limits = () => {
    const s = deps.uploads ?? DEFAULT_UPLOAD_SETTINGS;
    return {
      quotaDefaultBytes: s.defaultQuotaBytes,
      maxObjectsDefault: s.defaultMaxObjects ?? DEFAULT_TEAM_MAX_OBJECTS,
      historyMaxCommits: s.projectHistoryMaxCommits ?? PROJECT_HISTORY_MAX_COMMITS,
    };
  };
  app.get("/", async (c) => {
    const teamId = c.get("team").id;
    return c.json(await withTeam(db, teamId, (tx) => storageView(tx, teamId, limits())));
  });
  app.put("/", async (c) => {
    const body = await parseBody(c, storageSettingsSchema);
    if (!body) {
      return invalidRequest(
        c,
        "Send history_keep ({mode: all} or {mode: commits|days, n}), max_mounted_per_member or max_objects.",
      );
    }
    // GV2: a workspace may tighten the site's object budget, never raise it past the default.
    const ceiling = limits().maxObjectsDefault;
    if (body.max_objects !== undefined && body.max_objects !== null && body.max_objects > ceiling) {
      return invalidRequest(c, `max_objects may be at most the site default (${ceiling}).`);
    }
    const teamId = c.get("team").id;
    const view = await withTeam(db, teamId, async (tx) => {
      await writeStorageSettings(tx, teamId, c.get("user").id, body);
      return storageView(tx, teamId, limits());
    });
    return c.json(view);
  });
  return app;
}
