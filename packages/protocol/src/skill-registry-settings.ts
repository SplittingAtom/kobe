import { z } from "zod";
import { skillEvalLimitsSchema } from "./skill-evals/api.js";

/**
 * Registry settings (KOBE-330, spec SK20, SK21; one `site_skill_settings` row): the Registry team
 * (an existing team that runs all site-side work), the Site judge alias (SK17), the submission
 * rules (SK20), eval limits (SK18), the import allowlist (D2), the external scanner toggle (SK32)
 * and the git mirror (D1). Site admins change them; Skill reviewers can't (SK22). Until a Registry
 * team is named the Registry is "not ready" and Approve is refused.
 *
 * Every document parses with its defaults, so a fresh Site (empty JSON) reads the spec's values.
 */

const ratio = z.number().min(0).max(1);

/** SK20's table: a submission missing any rule is refused before review. */
export const registrySubmissionRulesSchema = z
  .strictObject({
    /** Eval cases, at least. */
    minCases: z.number().int().min(1).max(25).default(3),
    /** Negative trigger cases among them, at least. */
    minNegativeCases: z.number().int().min(0).max(25).default(1),
    /** Pass rate with the skill. */
    minPassRate: ratio.default(0.8),
    /** Lift over the no-skill baseline (−1..1). */
    minLift: z.number().min(-1).max(1).default(0),
    minTriggerPrecision: ratio.default(0.8),
    /** A Block scan verdict is refused (Caution and Pass go to review). */
    refuseBlockVerdict: z.boolean().default(true),
    /** `license` present in kobe.skill.yaml (internal skills may say `Proprietary`). */
    requireLicense: z.boolean().default(true),
    /** The scorecard is from this exact package hash. */
    requireFreshScorecard: z.boolean().default(true),
    /** Automatic retries per failing case (flakiness). */
    retriesPerFailingCase: z.number().int().min(0).max(3).default(1),
  })
  .refine((r) => r.minNegativeCases <= r.minCases, {
    message: "Negative cases can't outnumber all cases.",
    path: ["minNegativeCases"],
  });
export type RegistrySubmissionRules = z.infer<typeof registrySubmissionRulesSchema>;
export const REGISTRY_SUBMISSION_DEFAULTS: RegistrySubmissionRules =
  registrySubmissionRulesSchema.parse({});

/**
 * Where Kobe may import skills from (D2, KOBE-344, SK30 "hosts and organizations"): a lowercase
 * DNS host (`github.com`: any repository there) or a host and one owner (`github.com/acme`: only
 * that organization's or user's repositories). No scheme, port or deeper path.
 */
const IMPORT_HOST =
  "(?=[^/]{1,253}(/|$))([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+";
const importHostSchema = z
  .string()
  .max(354)
  .regex(
    new RegExp(`^${IMPORT_HOST}(/[a-z0-9]([a-z0-9._-]{0,98}[a-z0-9])?)?$`),
    "a host such as github.com, or a host and an owner such as github.com/acme",
  );
export const REGISTRY_IMPORT_HOSTS_MAX = 50;
export const registryImportAllowlistSchema = z
  .array(importHostSchema)
  .max(REGISTRY_IMPORT_HOSTS_MAX)
  .refine((hosts) => new Set(hosts).size === hosts.length, "a host twice");

/** The optional external scanner (SK32): off unless a Site admin turns it on. */
export const registryScannerSchema = z.strictObject({ external: z.boolean().default(false) });

/** The optional one-way git mirror (D1): an HTTPS remote when on; credentials live elsewhere. */
export const registryMirrorSchema = z
  .strictObject({
    enabled: z.boolean().default(false),
    url: z
      .url({ protocol: /^https$/ })
      .max(512)
      // The token lives in a Kubernetes Secret (SK29), never in the URL (review M1).
      .refine((u) => {
        const url = new URL(u);
        return url.username === "" && url.password === "" && url.search === "" && url.hash === "";
      }, "no credentials, query or fragment in the URL")
      .optional(),
    branch: z
      .string()
      .regex(/^[A-Za-z0-9._/-]{1,100}$/)
      .optional(),
  })
  .refine((m) => !m.enabled || m.url !== undefined, {
    message: "An enabled mirror needs an https URL.",
    path: ["url"],
  });

export const registryJudgeAliasSchema = z.string().min(1).max(64);

/**
 * `PUT /v1/site/skills/registry/settings`: any subset of the settings, at least one. The Registry
 * team is not among them: it is always a dedicated team Kobe creates ({@link
 * registryTeamCreateSchema}), never an existing one (coordinator decision, KOBE-330 review H1).
 */
export const registrySettingsUpdateSchema = z
  .strictObject({
    judgeAlias: registryJudgeAliasSchema.nullable().optional(),
    submissionRules: registrySubmissionRulesSchema.optional(),
    evalLimits: skillEvalLimitsSchema.optional(),
    importAllowlist: registryImportAllowlistSchema.optional(),
    scanner: registryScannerSchema.optional(),
    mirror: registryMirrorSchema.optional(),
  })
  .refine((u) => Object.keys(u).length > 0, { message: "Change at least one setting." });
export type RegistrySettingsUpdate = z.infer<typeof registrySettingsUpdateSchema>;

/**
 * `POST /v1/site/skills/registry/team`: Kobe creates the dedicated Registry team (flagged, at most
 * one), with the creating Site admin as its team admin and every Skill reviewer as a member.
 */
export const registryTeamCreateSchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  slug: z.string().regex(/^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/),
});
export type RegistryTeamCreate = z.infer<typeof registryTeamCreateSchema>;

export const REGISTRY_SETTING_NAMES = [
  "registryTeamId",
  "judgeAlias",
  "submissionRules",
  "evalLimits",
  "importAllowlist",
  "scanner",
  "mirror",
] as const;
export type RegistrySettingName = (typeof REGISTRY_SETTING_NAMES)[number];

/** `GET` (and `PUT`'s answer): the settings with their defaults filled in. */
export interface RegistrySettings {
  readonly ready: boolean;
  readonly registryTeam: {
    readonly id: string;
    readonly slug: string;
    readonly name: string;
  } | null;
  readonly judgeAlias: string | null;
  readonly submissionRules: RegistrySubmissionRules;
  readonly evalLimits: z.infer<typeof skillEvalLimitsSchema>;
  readonly importAllowlist: readonly string[];
  readonly scanner: z.infer<typeof registryScannerSchema>;
  readonly mirror: z.infer<typeof registryMirrorSchema>;
  readonly updatedAt: string;
}
