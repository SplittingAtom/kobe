import { z } from "zod";
import { SKILL_BLOCK_REASON_MAX } from "@kobe/db";
import { SITE_GRANTS } from "@kobe/protocol";
import { cursorSchema, kobeTool, page, type KobeRouteCaller } from "../../catalog.js";
import { clip, missing, readAs } from "./shared.js";

/**
 * Site console › Skill Registry review (`/v1/site/skills/registry`, each action its own Registry
 * permission through `skillReviewAllows`: Site admins and the Owner, or a Skill reviewer for the
 * reviewer's actions, SK22), › Skill blocklist (`site.blocklist.manage`) and › Users › Grants
 * (`site.grants.manage`; read with `site.users.manage`) (KOBE-622). Withdraw, revoke, Default tags,
 * Registry settings and re-runs stay in the console.
 */

const REGISTRY = "/site/skills/registry";
const STATE = z.string().max(40);
const person = z.object({ id: z.uuid(), name: z.string() }).nullable();
const queueRow = z.object({
  id: z.uuid(),
  skill: z.object({ id: z.uuid(), name: z.string() }),
  semver: z.string(),
  bump: z.string().nullable(),
  state: STATE,
  verdict: z.string().nullable(),
  submittedBy: person,
  submittedAt: z.string(),
  claimedBy: person,
});
const QUEUE_FILTER = z.enum([
  "open",
  "submitted",
  "in_review",
  "changes_requested",
  "approved",
  "rejected",
  "retracted",
  "all",
]);

export const siteSkillReviewsList = kobeTool({
  name: "site_skill_reviews_list",
  title: "List the Skill Registry review queue",
  description:
    "Lists Skill Registry submissions waiting for review (or another `state`: submitted, " +
    "in_review, changes_requested, approved, rejected, retracted, all; default open) with the " +
    "skill name, version, scan verdict, submitter and who claimed it (Site console › Skill " +
    "Registry). Paged: pass next_cursor back as cursor.",
  scope: "site",
  permission: "site.skills.review",
  skillReview: "queue.read",
  readOnly: true,
  input: z.strictObject({ state: QUEUE_FILTER.optional(), cursor: cursorSchema.optional() }),
  output: z.strictObject({
    items: z
      .array(
        z.strictObject({
          version_id: z.uuid(),
          skill_name: z.string().max(100),
          semver: z.string().max(40),
          bump: z.string().max(20).nullable(),
          state: STATE,
          verdict: z.string().max(20).nullable(),
          submitted_by: z.string().max(200).nullable(),
          submitted_at: z.string().max(40),
          claimed_by: z.string().max(200).nullable(),
        }),
      )
      .max(50),
    next_cursor: cursorSchema.optional(),
  }),
  route: (input) => ({ method: "GET", path: REGISTRY, query: { state: input.state ?? "open" } }),
  reduce: (body, input) => {
    const all = z.object({ items: z.array(queueRow) }).parse(body).items;
    const { rows, next_cursor } = page(all, input.cursor);
    return {
      items: rows.map((v) => ({
        version_id: v.id,
        skill_name: clip(v.skill.name, 100),
        semver: clip(v.semver, 40),
        bump: v.bump,
        state: v.state,
        verdict: v.verdict,
        submitted_by: v.submittedBy === null ? null : clip(v.submittedBy.name, 200),
        submitted_at: v.submittedAt,
        claimed_by: v.claimedBy === null ? null : clip(v.claimedBy.name, 200),
      })),
      ...(next_cursor === undefined ? {} : { next_cursor }),
    };
  },
});

const detail = z.object({ id: z.uuid(), state: STATE, claimedBy: person });

/** The version's review state as the person reads it (the review screen). */
async function reviewState(call: KobeRouteCaller, versionId: string) {
  const answer = await call({ method: "GET", path: `${REGISTRY}/${versionId}` });
  if (answer.status === 404) return undefined;
  const parsed = detail.safeParse(answer.body);
  return answer.status === 200 && parsed.success ? parsed.data : "unreadable";
}
const NO_VERSION = missing("not_found", "No such Registry version.");
const reviewOut = z.strictObject({ version_id: z.uuid(), state: STATE });
const reviewAnswer = (body: unknown) => {
  const a = z.object({ id: z.uuid(), state: STATE }).parse(body);
  return { version_id: a.id, state: a.state };
};
const DECIDABLE = z.enum(["submitted", "in_review"]);
const note = z.string().trim().min(1).max(4000);

export const siteSkillReviewsClaim = kobeTool({
  name: "site_skill_reviews_claim",
  title: "Claim a Registry submission",
  description:
    "Claims a submitted Skill Registry version for review (Submitted → In review, held by the " +
    "person), so no other reviewer decides it meanwhile (Site console › Skill Registry). Give " +
    "the version_id and from_state `submitted` (from site_skill_reviews_list). The person is " +
    "always asked to approve; never retry a refused or denied call.",
  scope: "site",
  permission: "site.skills.review",
  skillReview: "claim",
  readOnly: false,
  destructive: false,
  input: z.strictObject({ version_id: z.uuid(), from_state: z.literal("submitted") }),
  output: reviewOut,
  route: (input) => ({
    method: "POST",
    path: `${REGISTRY}/${input.version_id}/claim`,
    query: { expectedState: input.from_state },
  }),
  reduce: reviewAnswer,
  before: async (input, call) => {
    const v = await reviewState(call, input.version_id);
    if (v === undefined) return NO_VERSION;
    return v !== "unreadable" && v.state === input.from_state ? "same" : "changed";
  },
  summary: (input) => `Claim Skill Registry version ${input.version_id} for review`,
});

export const siteSkillReviewsComment = kobeTool({
  name: "site_skill_reviews_comment",
  title: "Comment on a Registry submission",
  description:
    "Adds a review comment to a Skill Registry version, visible to the submitter in their " +
    "Workbench (Site console › Skill Registry). The person is always asked to approve; never " +
    "retry a refused or denied call.",
  scope: "site",
  permission: "site.skills.review",
  skillReview: "comment",
  readOnly: false,
  destructive: false,
  input: z.strictObject({ version_id: z.uuid(), note }),
  output: reviewOut,
  route: (input) => ({
    method: "POST",
    path: `${REGISTRY}/${input.version_id}/comments`,
    body: { note: input.note },
  }),
  reduce: reviewAnswer,
  // A comment changes no state: its before-state is only that the version exists.
  before: async (input, call) =>
    (await reviewState(call, input.version_id)) === undefined ? NO_VERSION : "same",
  summary: (input) =>
    `Comment on Skill Registry version ${input.version_id}: "${clip(input.note, 120)}"`,
});

export const siteSkillReviewsDecide = kobeTool({
  name: "site_skill_reviews_decide",
  title: "Decide a Registry submission",
  description:
    "Approves a Skill Registry version into the catalog, requests changes (sent back to the " +
    "author's Workbench; needs a note) or rejects it (Site console › Skill Registry). Give the " +
    "version_id, its current state (submitted or in_review, from site_skill_reviews_list), the " +
    "action and an optional note. Reject-and-block is a separate tool for site admins. The " +
    "person is always asked to approve; never retry a refused or denied call.",
  scope: "site",
  permission: "site.skills.review",
  skillReview: "approve",
  readOnly: false,
  destructive: false,
  input: z
    .strictObject({
      version_id: z.uuid(),
      from_state: DECIDABLE,
      action: z.enum(["approve", "request_changes", "reject"]),
      note: note.optional(),
    })
    .refine((v) => v.action !== "request_changes" || v.note !== undefined, {
      message: "Request changes needs a note for the author.",
    }),
  output: reviewOut,
  route: (input) => ({
    method: "POST",
    path: `${REGISTRY}/${input.version_id}/decision`,
    body: {
      action: input.action,
      ...(input.note === undefined ? {} : { note: input.note }),
      expected_state: input.from_state,
    },
  }),
  reduce: reviewAnswer,
  before: async (input, call) => {
    const v = await reviewState(call, input.version_id);
    if (v === undefined) return NO_VERSION;
    return v !== "unreadable" && v.state === input.from_state ? "same" : "changed";
  },
  summary: (input) =>
    `${{ approve: "Approve", request_changes: "Request changes on", reject: "Reject" }[input.action]} Skill Registry version ${input.version_id}`,
});

export const siteSkillReviewsRejectAndBlock = kobeTool({
  name: "site_skill_reviews_reject_and_block",
  title: "Reject and block a Registry submission",
  description:
    "Rejects a Skill Registry version and puts its package hash on the site skill blocklist, so " +
    "it can't be uploaded, approved or run in any team (Site console › Skill Registry; site " +
    "admins only, never Skill reviewers). Give the version_id, its current state and a note. " +
    "The person is always asked to approve; never retry a refused or denied call.",
  scope: "site",
  permission: "site.skills.review",
  skillReview: "reject_and_block",
  readOnly: false,
  destructive: false,
  input: z.strictObject({ version_id: z.uuid(), from_state: DECIDABLE, note }),
  output: reviewOut,
  route: (input) => ({
    method: "POST",
    path: `${REGISTRY}/${input.version_id}/decision`,
    body: { action: "reject_and_block", note: input.note, expected_state: input.from_state },
  }),
  reduce: reviewAnswer,
  before: async (input, call) => {
    const v = await reviewState(call, input.version_id);
    if (v === undefined) return NO_VERSION;
    return v !== "unreadable" && v.state === input.from_state ? "same" : "changed";
  },
  summary: (input) =>
    `Reject Skill Registry version ${input.version_id} and block its package site-wide`,
});

const hash = z.string().regex(/^[0-9a-f]{64}$/, "a lowercase SHA-256 hash (64 hex characters)");
const blockCursor = z
  .string()
  .max(400)
  .regex(/^[A-Za-z0-9_-]+$/);
const blockRow = z.object({
  contentHash: z.string(),
  reason: z.string(),
  addedBy: z.string(),
  addedAt: z.string(),
});
const blockOut = z.strictObject({
  content_hash: z.string().max(64),
  reason: z.string().max(SKILL_BLOCK_REASON_MAX),
  added_by: z.string().max(64),
  added_at: z.string().max(40),
});
const toBlockOut = (e: z.infer<typeof blockRow>) => ({
  content_hash: e.contentHash,
  reason: clip(e.reason, SKILL_BLOCK_REASON_MAX),
  added_by: e.addedBy,
  added_at: e.addedAt,
});

export const siteSkillBlocklistList = kobeTool({
  name: "site_skill_blocklist_list",
  title: "List the skill blocklist",
  description:
    "Lists the skill package hashes blocked site-wide (can't be uploaded, approved or run in any " +
    "team) with the reason, who added each and when (Site console › Skill blocklist). Paged: " +
    "pass next_cursor back as cursor.",
  scope: "site",
  permission: "site.blocklist.manage",
  readOnly: true,
  input: z.strictObject({ cursor: blockCursor.optional() }),
  output: z.strictObject({
    entries: z.array(blockOut).max(50),
    next_cursor: blockCursor.optional(),
  }),
  route: (input) => ({
    method: "GET",
    path: "/site/skill-blocklist",
    query: { limit: "50", ...(input.cursor === undefined ? {} : { cursor: input.cursor }) },
  }),
  reduce: (body) => {
    const a = z
      .object({ entries: z.array(blockRow), nextCursor: z.string().nullable() })
      .parse(body);
    const next = a.nextCursor === null ? undefined : blockCursor.safeParse(a.nextCursor);
    return {
      entries: a.entries.slice(0, 50).map(toBlockOut),
      ...(next?.success === true ? { next_cursor: next.data } : {}),
    };
  },
});

export const siteSkillBlocklistAdd = kobeTool({
  name: "site_skill_blocklist_add",
  title: "Block a skill package",
  description:
    "Blocks a skill package hash site-wide (Site console › Skill blocklist): it can no longer be " +
    "uploaded, approved or run in any team. Give the package's SHA-256 content hash and a " +
    "reason. The person is always asked to approve; never retry a refused or denied call.",
  scope: "site",
  permission: "site.blocklist.manage",
  readOnly: false,
  destructive: false,
  input: z.strictObject({
    content_hash: hash,
    reason: z.string().trim().min(1).max(SKILL_BLOCK_REASON_MAX),
  }),
  output: blockOut,
  route: (input) => ({
    method: "POST",
    path: "/site/skill-blocklist",
    body: { contentHash: input.content_hash, reason: input.reason },
  }),
  reduce: (body) => toBlockOut(z.object({ entry: blockRow }).parse(body).entry),
  // Not blocked yet: the route refuses a hash already on the list (already_blocked).
  before: () => Promise.resolve("same"),
  summary: (input) =>
    `Block skill package ${input.content_hash} site-wide: "${clip(input.reason, 120)}"`,
});

export const siteSkillBlocklistRemove = kobeTool({
  name: "site_skill_blocklist_remove",
  title: "Unblock a skill package",
  description:
    "Removes a skill package hash from the site blocklist (Site console › Skill blocklist), so " +
    "teams may upload, approve and run it again. The person is always asked to approve; never " +
    "retry a refused or denied call.",
  scope: "site",
  permission: "site.blocklist.manage",
  readOnly: false,
  destructive: false,
  input: z.strictObject({ content_hash: hash }),
  output: z.strictObject({ content_hash: z.string().max(64), blocked: z.literal(false) }),
  route: (input) => ({ method: "DELETE", path: `/site/skill-blocklist/${input.content_hash}` }),
  reduce: (_body, input) => ({ content_hash: input.content_hash, blocked: false as const }),
  // Blocked now: the route refuses a hash that is not on the list (not_found).
  before: () => Promise.resolve("same"),
  summary: (input) => `Unblock skill package ${input.content_hash} (teams may use it again)`,
});

const GRANT = z.enum(SITE_GRANTS);
const GRANTS = { method: "GET", path: "/site/roles/grants" } as const;
const grantRow = z.object({
  userId: z.uuid(),
  name: z.string(),
  email: z.string(),
  grant: GRANT,
  grantedAt: z.string(),
  deactivated: z.boolean(),
});
const grantsAnswer = z.object({ grants: z.array(grantRow) });

export const siteGrantsList = kobeTool({
  name: "site_grants_list",
  title: "List site grants",
  description:
    "Lists who holds a site grant: Skill reviewer (reviews Skill Registry submissions without " +
    "being a site admin) or memory_steward (Site memory steward: curates Site memory, never " +
    "Policy) (Site console › Site roles). Paged: pass next_cursor back as cursor.",
  scope: "site",
  permission: "site.users.manage",
  readOnly: true,
  input: z.strictObject({ cursor: cursorSchema.optional() }),
  output: z.strictObject({
    grants: z
      .array(
        z.strictObject({
          user_id: z.uuid(),
          name: z.string().max(200),
          email: z.string().max(320),
          grant: GRANT,
          granted_at: z.string().max(40),
          deactivated: z.boolean(),
        }),
      )
      .max(50),
    next_cursor: cursorSchema.optional(),
  }),
  route: () => GRANTS,
  reduce: (body, input) => {
    const { rows, next_cursor } = page(grantsAnswer.parse(body).grants, input.cursor);
    return {
      grants: rows.map((g) => ({
        user_id: g.userId,
        name: clip(g.name, 200),
        email: clip(g.email, 320),
        grant: g.grant,
        granted_at: g.grantedAt,
        deactivated: g.deactivated,
      })),
      ...(next_cursor === undefined ? {} : { next_cursor }),
    };
  },
});

async function holds(call: KobeRouteCaller, userId: string, grant: string) {
  const a = await readAs(call, GRANTS, grantsAnswer);
  return a === undefined
    ? undefined
    : a.grants.some((g) => g.userId === userId && g.grant === grant);
}

export const siteGrantsGive = kobeTool({
  name: "site_grants_give",
  title: "Give a site grant",
  description:
    "Gives a user a site grant: skill_reviewer (may review, approve, request changes on and " +
    "reject Skill Registry submissions, never block; also adds them to the Registry team) or " +
    "memory_steward (Site memory steward: curates Site memory, never sets Policy or accepts Site " +
    "proposals) (Site console › Site roles). Another admin must grant you; never a deactivated " +
    "account. The person is always asked to approve; never retry a refused or denied call.",
  scope: "site",
  permission: "site.grants.manage",
  readOnly: false,
  destructive: false,
  input: z.strictObject({ user_id: z.uuid(), grant: GRANT }),
  output: z.strictObject({ user_id: z.uuid(), grant: GRANT, held: z.literal(true) }),
  route: (input) => ({
    method: "PUT",
    path: `/site/roles/grants/${input.user_id}/${input.grant}`,
    body: {},
  }),
  reduce: (_body, input) => ({ user_id: input.user_id, grant: input.grant, held: true as const }),
  before: async (input, call) => {
    const held = await holds(call, input.user_id, input.grant);
    return held === false ? "same" : "changed";
  },
  summary: (input) => `Give user ${input.user_id} the ${input.grant} grant`,
});

export const siteGrantsTake = kobeTool({
  name: "site_grants_take",
  title: "Take a site grant",
  description:
    "Takes a site grant (skill_reviewer or memory_steward) from a user; for Skill reviewer also " +
    "the Registry team membership the grant made (Site console › Site roles). The person is always " +
    "asked to approve; never retry a refused or denied call.",
  scope: "site",
  permission: "site.grants.manage",
  readOnly: false,
  destructive: false,
  input: z.strictObject({ user_id: z.uuid(), grant: GRANT }),
  output: z.strictObject({ user_id: z.uuid(), grant: GRANT, held: z.literal(false) }),
  route: (input) => ({
    method: "DELETE",
    path: `/site/roles/grants/${input.user_id}/${input.grant}`,
  }),
  reduce: (_body, input) => ({ user_id: input.user_id, grant: input.grant, held: false as const }),
  before: async (input, call) => {
    const held = await holds(call, input.user_id, input.grant);
    return held === true ? "same" : "changed";
  },
  summary: (input) => `Take the ${input.grant} grant from user ${input.user_id}`,
});
