/** Caps on an uploaded skill bundle (KOBE-78). Validation refuses anything above them. */
export interface SkillLimits {
  /** Upload size (the zip, or the SKILL.md file). */
  readonly maxBundleBytes: number;
  readonly maxFiles: number;
  /** Sum of the declared uncompressed sizes. */
  readonly maxUncompressedBytes: number;
  readonly maxFileBytes: number;
  /** SKILL.md alone: it is read into memory and parsed. */
  readonly maxSkillMdBytes: number;
  /** Uncompressed-to-compressed ratio above which an entry or the bundle counts as a zip bomb. */
  readonly maxRatio: number;
  /** Ratios are only judged above this size: tiny files legitimately compress very well. */
  readonly ratioFloorBytes: number;
  readonly maxPathBytes: number;
}

export const SKILL_LIMITS: SkillLimits = {
  maxBundleBytes: 5 * 1024 * 1024,
  maxFiles: 200,
  maxUncompressedBytes: 25 * 1024 * 1024,
  maxFileBytes: 10 * 1024 * 1024,
  maxSkillMdBytes: 100 * 1024,
  maxRatio: 100,
  ratioFloorBytes: 1024 * 1024,
  maxPathBytes: 240,
};

/** Versions per skill: the backstop against an upload loop. */
export const MAX_SKILL_VERSIONS = 500;
/** Live (not archived) skills per team or personal owner. */
export const MAX_LIVE_SKILLS = 500;
