import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AuthVariables } from "../auth/session.js";
import {
  SKILL_REVIEW_FORBIDDEN,
  mayReviewSkills,
  requireSkillReview,
} from "../authz/middleware.js";
import { siteRoleAllows } from "../authz/permissions.js";
import type { ServerDeps } from "../deps.js";
import { approve, type Problem } from "../skills/registry/review-approve.js";
import {
  claim,
  comment,
  decide,
  unclaim,
  type ReviewResult,
} from "../skills/registry/review-decide.js";
import { REVIEW_CHECKLIST, reviewDetail } from "../skills/registry/review-detail.js";
import { acknowledge } from "../skills/registry/review-findings.js";
import { diffOneFile, rawFile } from "../skills/registry/review-diff.js";
import { cancelRerun, rerunEvals } from "../skills/registry/rerun.js";
import { notifySubmitter } from "../skills/registry/review-notify.js";
import {
  QUEUE_FILTERS,
  approvedVersion,
  listQueue,
  versionBytes,
  versionDiff,
  versionRow,
  type VersionRow,
} from "../skills/registry/review-queue.js";
import { invalidRequest, parseBody } from "../teams/http.js";

type Ctx = Context<{ Variables: AuthVariables }>;

const idSchema = z.uuid();
const noteSchema = z.string().trim().min(1).max(4000);
const checklistSchema = z.strictObject(
  Object.fromEntries(REVIEW_CHECKLIST.map((i) => [i.id, z.boolean().optional()])) as Record<
    (typeof REVIEW_CHECKLIST)[number]["id"],
    z.ZodOptional<z.ZodBoolean>
  >,
);
const commentSchema = z.strictObject({ note: noteSchema });
const acknowledgeSchema = z.strictObject({ finding: z.string().min(1).max(700) });
const decisionSchema = z
  .strictObject({
    action: z.enum(["approve", "request_changes", "reject", "reject_and_block"]),
    note: noteSchema.optional(),
    checklist: checklistSchema.optional(),
  })
  // Request changes goes back to the author's Workbench: it needs the comments (SK23).
  .refine((b) => b.action !== "request_changes" || b.note !== undefined, {
    message: "Request changes needs a note for the author.",
  });

const STATUS: Readonly<Record<string, 403 | 404 | 409>> = {
  not_found: 404,
  unknown_finding: 404,
  own_submission: 403,
  block_verdict: 403,
  confirmed_by_you: 403,
};

const refuse = (c: Ctx, p: Problem) =>
  c.json({ code: p.code, message: p.message }, STATUS[p.code] ?? 409);

const NOT_FOUND = { code: "not_found", message: "No such Registry version." } as const;
const MISSING = { code: "package_missing", message: "The package's bytes are missing." };
const UNAVAILABLE = { code: "storage_unavailable", message: "Skill storage is not configured." };

/**
 * The Registry review console (KOBE-334, SK22, SK23) under `/v1/site/skills/registry`: the queue,
 * a version's evidence and its diff against the approved version, claims, comments and decisions.
 * Every route is behind `requireSkillReview` with its own action, so Skill reviewers do exactly
 * what SK22 lets them (never Reject and block). Each state change emails the submitter.
 */
export function registryReviewRoutes(deps: ServerDeps): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();
  const db = deps.database.db;

  const tell = (v: VersionRow, note: string | null) =>
    deps.background.run("registry review email failed", () =>
      notifySubmitter(
        { db, mailer: deps.mailer, publicUrl: new URL(deps.publicUrl).origin },
        { submittedBy: v.submittedBy, name: v.name, semver: v.semver, state: v.state, note },
      ),
    );

  const answer = (c: Ctx, r: ReviewResult, note: string | null = null, notify = true) => {
    if (!r.ok) return refuse(c, r.problem);
    if (r.changed && notify) tell(r.version, note);
    return c.json({ id: r.version.id, state: r.version.state });
  };

  const versionId = (c: Ctx) => {
    const id = idSchema.safeParse(c.req.param("id"));
    return id.success ? id.data : null;
  };

  app.get("/", requireSkillReview(deps, "queue.read"), async (c) => {
    const state = c.req.query("state") ?? "open";
    if (!(QUEUE_FILTERS as readonly string[]).includes(state))
      return invalidRequest(c, `state is one of ${QUEUE_FILTERS.join(", ")}.`);
    if (!deps.blobs) return c.json(UNAVAILABLE, 503);
    return c.json({
      items: await listQueue(db, deps.blobs, state as (typeof QUEUE_FILTERS)[number]),
    });
  });

  app.get("/:id", requireSkillReview(deps, "queue.read"), async (c) => {
    const id = versionId(c);
    const detail = id ? await reviewDetail(db, id, c.get("user").id) : null;
    return detail ? c.json(detail) : c.json(NOT_FOUND, 404);
  });

  // The review screen opens on this (SK23): the package against the approved version.
  app.get("/:id/diff", requireSkillReview(deps, "queue.read"), async (c) => {
    if (!deps.blobs) return c.json(UNAVAILABLE, 503);
    const id = versionId(c);
    const v = id ? await versionRow(db, id) : undefined;
    if (!v || v.publisher !== "maintainer") return c.json(NOT_FOUND, 404);
    const approved = await approvedVersion(db, v.skillId, v.id);
    // One file on its own, with a request's budget: "Load diff" for a skipped file (M2).
    const path = c.req.query("path");
    if (path !== undefined) {
      const bytes = await versionBytes(deps.blobs, v, approved);
      if (!bytes) return c.json(MISSING, 409);
      const file = diffOneFile(bytes.before, bytes.after, path);
      return file ? c.json(file) : c.json({ code: "not_found", message: "No such file." }, 404);
    }
    const diff = await versionDiff(deps.blobs, v, approved);
    if (!diff) return c.json(MISSING, 409);
    return c.json({
      against: approved ? { id: approved.id, semver: approved.semver } : null,
      ...diff,
    });
  });

  // A submitted file as text, whole (to 1 MiB): for files too large or too different to diff (M2).
  app.get("/:id/file", requireSkillReview(deps, "queue.read"), async (c) => {
    if (!deps.blobs) return c.json(UNAVAILABLE, 503);
    const id = versionId(c);
    const path = c.req.query("path");
    const v = id ? await versionRow(db, id) : undefined;
    if (!v || v.publisher !== "maintainer" || !path) return c.json(NOT_FOUND, 404);
    const bytes = await versionBytes(deps.blobs, v, undefined);
    if (!bytes) return c.json(MISSING, 409);
    const file = rawFile(bytes.after, path);
    return file ? c.json(file) : c.json({ code: "not_found", message: "No such file." }, 404);
  });

  app.post("/:id/claim", requireSkillReview(deps, "claim"), async (c) => {
    const id = versionId(c);
    if (!id) return c.json(NOT_FOUND, 404);
    return answer(c, await claim(db, id, c.get("user").id));
  });

  app.delete("/:id/claim", requireSkillReview(deps, "claim"), async (c) => {
    const id = versionId(c);
    if (!id) return c.json(NOT_FOUND, 404);
    const takeOver = siteRoleAllows(c.get("siteRole"), "site.skills.review");
    return answer(c, await unclaim(db, id, c.get("user").id, takeOver));
  });

  app.post("/:id/comments", requireSkillReview(deps, "comment"), async (c) => {
    const id = versionId(c);
    const body = await parseBody(c, commentSchema);
    if (!id) return c.json(NOT_FOUND, 404);
    if (!body) return invalidRequest(c, "Send a note (up to 4000 characters).");
    // A comment is for reviewers: no state changes, so no email.
    return answer(c, await comment(db, id, c.get("user").id, body.note), null, false);
  });

  // Re-run evals in the Registry team with the Site judge (KOBE-335): the authoritative scorecard.
  app.post("/:id/rerun-evals", requireSkillReview(deps, "rerun"), async (c) => {
    const id = versionId(c);
    if (!id) return c.json(NOT_FOUND, 404);
    if (!deps.blobs) return c.json(UNAVAILABLE, 503);
    const r = await rerunEvals({ db, blobs: deps.blobs }, id, c.get("user").id);
    if (!r.ok) return c.json({ code: r.code, message: r.message }, r.status);
    return c.json({ evalRunId: r.evalRunId }, 202);
  });

  // Cancel one re-run (eligible reviewers only; the history keeps it, review-335 M3).
  app.post("/:id/reruns/:evalRunId/cancel", requireSkillReview(deps, "rerun"), async (c) => {
    const id = versionId(c);
    const run = idSchema.safeParse(c.req.param("evalRunId"));
    if (!id || !run.success) return c.json(NOT_FOUND, 404);
    const r = await cancelRerun(db, id, run.data, c.get("user").id);
    if (!r.ok) return c.json({ code: r.code, message: r.message }, r.status);
    return c.json({ evalRunId: r.evalRunId, status: "cancelled" }, 202);
  });

  // One Caution finding acknowledged (review M1): Approve needs every one.
  app.post("/:id/acknowledgements", requireSkillReview(deps, "approve"), async (c) => {
    const id = versionId(c);
    const body = await parseBody(c, acknowledgeSchema);
    if (!id) return c.json(NOT_FOUND, 404);
    if (!body) return invalidRequest(c, "Send the finding's key.");
    const r = await acknowledge(db, id, c.get("user").id, body.finding);
    if (!r.ok) return refuse(c, r.problem);
    return c.json({ finding: body.finding, acknowledged: true, changed: r.changed });
  });

  app.post("/:id/decision", async (c) => {
    const id = versionId(c);
    const body = await parseBody(c, decisionSchema);
    if (!id) return c.json(NOT_FOUND, 404);
    if (!body)
      return invalidRequest(
        c,
        "Send action (approve, request_changes, reject, reject_and_block), a note and the checklist.",
      );
    // Each action is its own Registry permission (SK22): Skill reviewers never block.
    if (!(await mayReviewSkills(deps, c.get("siteRole"), c.get("user").id, body.action)))
      return c.json(SKILL_REVIEW_FORBIDDEN, 403);
    const input = { note: body.note ?? null, checklist: body.checklist ?? null };
    const userId = c.get("user").id;
    if (body.action === "approve") {
      const r = await approve(db, id, userId, input);
      if (!r.ok) return refuse(c, r.problem);
      tell(r.version, input.note);
      return c.json({ id: r.version.id, state: r.version.state, selfApproved: r.selfApproved });
    }
    return answer(c, await decide(db, id, userId, body.action, input), input.note);
  });

  return app;
}
