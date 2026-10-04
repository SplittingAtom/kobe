/**
 * The server's caps on a skill bundle (services/server/src/skills/limits.ts, KOBE-78), repeated
 * here only to give clear messages before sending. The server stays the authority.
 */
export const SKILL_LIMITS = {
  maxBundleBytes: 5 * 1024 * 1024,
  maxFiles: 200,
  maxUncompressedBytes: 25 * 1024 * 1024,
  maxFileBytes: 10 * 1024 * 1024,
  maxSkillMdBytes: 100 * 1024,
  maxFrontmatterBytes: 16 * 1024,
  maxPathBytes: 240,
  descriptionMax: 1024,
} as const;

/** Lowercase words joined by hyphens, up to 64 characters (the skill's slug). */
export const SKILL_NAME = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/;
export const SKILL_MD = "SKILL.md";
