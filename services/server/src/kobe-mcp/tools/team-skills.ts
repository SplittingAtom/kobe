import { z } from "zod";
import {
  cursorSchema,
  kobeTool,
  page,
  routeCursorSchema,
  type BeforeState,
  type KobeRouteCaller,
} from "../catalog.js";

/**
 * Team console › Skills (catalog installs, page permission `team.skills.publish`) and › Skill
 * review (`/v1/team/skill-review`, `team.skills.review`). Every new version of a team skill waits
 * for a review before any run may use it; a decision names exactly one version.
 */

const skillInstallRow = z.object({
  skillId: z.uuid(),
  name: z.string(),
  semver: z.string(),
  pinMode: z.string(),
  access: z.string(),
  origin: z.string(),
  isDefault: z.boolean(),
  retirement: z.unknown().nullable(),
});
const installsAnswer = z.object({
  installs: z.array(skillInstallRow),
  removedDefaults: z.array(z.object({ skillId: z.uuid(), name: z.string() })),
});

export const teamSkillInstallsList = kobeTool({
  name: "team_skills_installs_list",
  title: "List the team's catalog skills",
  description:
    "Lists the catalog skills installed in the conversation's team: version, pin mode, access " +
    "(available, default_on, required, hidden), whether it is a site Default, and the Default " +
    "skills the team removed (Team console › Skills). Paged: pass next_cursor back as cursor.",
  scope: "team",
  permission: "team.skills.publish",
  readOnly: true,
  input: z.strictObject({ cursor: cursorSchema.optional() }),
  output: z.strictObject({
    installs: z
      .array(
        z.strictObject({
          skill_id: z.uuid(),
          name: z.string().max(200),
          version: z.string().max(64),
          pin_mode: z.string().max(20),
          access: z.string().max(20),
          site_default: z.boolean(),
          retired: z.boolean(),
        }),
      )
      .max(50),
    removed_defaults: z
      .array(z.strictObject({ skill_id: z.uuid(), name: z.string().max(200) }))
      .max(50),
    next_cursor: cursorSchema.optional(),
  }),
  route: () => ({ method: "GET", path: "/team/skills/installs" }),
  reduce: (body, input) => {
    const answer = installsAnswer.parse(body);
    const { rows, next_cursor } = page(answer.installs, input.cursor);
    return {
      installs: rows.map((i) => ({
        skill_id: i.skillId,
        name: i.name.slice(0, 200),
        version: i.semver.slice(0, 64),
        pin_mode: i.pinMode.slice(0, 20),
        access: i.access.slice(0, 20),
        site_default: i.isDefault,
        retired: i.retirement !== null,
      })),
      // Only with the first page: the list is short (one row per removed Default).
      removed_defaults:
        input.cursor === undefined
          ? answer.removedDefaults
              .slice(0, 50)
              .map((d) => ({ skill_id: d.skillId, name: d.name.slice(0, 200) }))
          : [],
      ...(next_cursor === undefined ? {} : { next_cursor }),
    };
  },
});

const reviewStatus = z.enum(["pending", "approved", "rejected"]);

const reviewRow = z.object({
  skillId: z.uuid(),
  slug: z.string(),
  version: z.number().int(),
  semver: z.string(),
  scope: z.string(),
  unscanned: z.boolean(),
  status: reviewStatus,
  flagged: z.boolean(),
  verdict: z.string(),
  findingsDigest: z.string(),
  findings: z.array(
    z.object({
      category: z.string(),
      rule: z.string(),
      file: z.string(),
      line: z.number(),
      severity: z.string().optional(),
    }),
  ),
  blocked: z.boolean(),
  suspended: z.boolean(),
});
const reviewsAnswer = z.object({ reviews: z.array(reviewRow), nextCursor: z.string().nullable() });

const FINDINGS_SHOWN = 10;

const reviewOut = z.strictObject({
  skill_id: z.uuid(),
  slug: z.string().max(200),
  version: z.number().int(),
  semver: z.string().max(64),
  scope: z.string().max(20),
  status: reviewStatus,
  /** pass, caution or block: approving caution or block needs findings_digest. */
  verdict: z.string().max(20),
  flagged: z.boolean(),
  unscanned: z.boolean(),
  blocklisted: z.boolean(),
  suspended: z.boolean(),
  findings_digest: z.string().max(64),
  finding_count: z.number().int().nonnegative(),
  /** The first findings: rule and place only, never the skill's text. */
  findings: z
    .array(
      z.strictObject({
        severity: z.string().max(20),
        category: z.string().max(100),
        rule: z.string().max(100),
        file: z.string().max(300),
        line: z.number(),
      }),
    )
    .max(FINDINGS_SHOWN),
});

export const teamSkillReviewsList = kobeTool({
  name: "team_skill_reviews_list",
  title: "List skill versions to review",
  description:
    "Lists the team's skill versions by review status (default pending; flagged first) with the " +
    "scan's verdict and findings (rule and file, not the skill's text) (Team console › Skill " +
    "review). Every new version of a team skill waits here until approved. Paged: pass " +
    "next_cursor back as cursor.",
  scope: "team",
  permission: "team.skills.review",
  readOnly: true,
  input: z.strictObject({
    status: z.enum(["pending", "approved", "rejected", "all"]).optional(),
    cursor: routeCursorSchema.optional(),
  }),
  output: z.strictObject({
    reviews: z.array(reviewOut).max(50),
    next_cursor: routeCursorSchema.optional(),
  }),
  route: (input) => ({
    method: "GET",
    path: "/team/skill-review",
    query: {
      status: input.status ?? "pending",
      limit: "50",
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    },
  }),
  reduce: (body) => {
    const answer = reviewsAnswer.parse(body);
    return {
      reviews: answer.reviews.slice(0, 50).map((r) => ({
        skill_id: r.skillId,
        slug: r.slug.slice(0, 200),
        version: r.version,
        semver: r.semver.slice(0, 64),
        scope: r.scope.slice(0, 20),
        status: r.status,
        verdict: r.verdict.slice(0, 20),
        flagged: r.flagged,
        unscanned: r.unscanned,
        blocklisted: r.blocked,
        suspended: r.suspended,
        findings_digest: r.findingsDigest.slice(0, 64),
        finding_count: r.findings.length,
        findings: r.findings.slice(0, FINDINGS_SHOWN).map((f) => ({
          severity: (f.severity ?? "caution").slice(0, 20),
          category: f.category.slice(0, 100),
          rule: f.rule.slice(0, 100),
          file: f.file.slice(0, 300),
          line: f.line,
        })),
      })),
      ...(answer.nextCursor !== null && routeCursorSchema.safeParse(answer.nextCursor).success
        ? { next_cursor: answer.nextCursor }
        : {}),
    };
  },
});

const decideInput = z.strictObject({
  skill_id: z.uuid(),
  version: z.number().int().positive().max(2147483647),
  /** The review's status as the person saw it (team_skill_reviews_list). */
  from_status: reviewStatus,
  /** approve, or request_changes (the version is rejected; its author publishes a new one). */
  decision: z.enum(["approve", "request_changes"]),
  /** Approving a caution or block scan: the findings_digest of the findings the person read. */
  findings_digest: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  /** Shown to the skill's author; required to approve a block scan (site admins only). */
  note: z.string().trim().max(2000).optional(),
});

/**
 * One version's review as the person reads it (the first 200 rows, flagged first); `beyond` when
 * it is not among them but more rows exist (the route's own condition then decides).
 */
async function reviewOf(call: KobeRouteCaller, skillId: string, version: number) {
  const answer = await call({
    method: "GET",
    path: "/team/skill-review",
    query: { status: "all", limit: "200" },
  });
  if (answer.status !== 200) return "unreadable" as const;
  const parsed = reviewsAnswer.safeParse(answer.body);
  if (!parsed.success) return "unreadable" as const;
  const found = parsed.data.reviews.find((r) => r.skillId === skillId && r.version === version);
  if (found === undefined && parsed.data.nextCursor !== null) return "beyond" as const;
  return found;
}

const DECISION = { approve: "approved", request_changes: "rejected" } as const;
const DECISION_LABEL = { approve: "Approve", request_changes: "Request changes on" } as const;

export const teamSkillReviewsDecide = kobeTool({
  name: "team_skill_reviews_decide",
  title: "Approve a skill version or request changes",
  description:
    "Approves one version of a team skill so the team's runs may use it, or requests changes " +
    "(the version is rejected; its author publishes a new one) (Team console › Skill review). " +
    "Give skill_id, version and from_status from team_skill_reviews_list; approving a caution or " +
    "block verdict needs its findings_digest, and the person must have read the findings. The " +
    "person is always asked to approve; never retry a refused or denied call.",
  scope: "team",
  permission: "team.skills.review",
  readOnly: false,
  destructive: false,
  input: decideInput,
  output: z.strictObject({
    skill_id: z.uuid(),
    version: z.number().int(),
    status: reviewStatus,
  }),
  route: (input) => ({
    method: "POST",
    path: `/team/skill-review/${input.skill_id}/versions/${input.version}`,
    body: {
      decision: DECISION[input.decision],
      expectedStatus: input.from_status,
      ...(input.note === undefined ? {} : { note: input.note }),
      ...(input.findings_digest === undefined
        ? {}
        : { acknowledgedFindings: input.findings_digest }),
    },
  }),
  reduce: (body) => {
    const { review } = z
      .object({
        review: z.object({ skillId: z.uuid(), version: z.number(), status: reviewStatus }),
      })
      .parse(body);
    return { skill_id: review.skillId, version: review.version, status: review.status };
  },
  before: async (input, call): Promise<BeforeState> => {
    const current = await reviewOf(call, input.skill_id, input.version);
    if (current === "unreadable") return "changed";
    if (current === "beyond") return "same";
    if (current === undefined) return { code: "not_found", message: "No such skill version." };
    return current.status === input.from_status ? "same" : "changed";
  },
  summary: (input) =>
    `${DECISION_LABEL[input.decision]} skill ${input.skill_id} version ${input.version} ` +
    `(now ${input.from_status})`,
});
