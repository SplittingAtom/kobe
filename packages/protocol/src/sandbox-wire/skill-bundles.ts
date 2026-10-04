import { z } from "zod";
import { sha256HexSchema } from "./workspace-sync.js";

/**
 * Skill bundle delivery (KOBE-82, spec D22): how a run's effective skills reach the sandbox.
 *
 * - `run.start.config.skill_bundles` lists each effective skill as `{name, sha256, size}`: the
 *   SHA-256 and byte size of the **canonical zip** (KOBE-78) the server decided to use. The
 *   server drops blocklisted, unapproved and team-disabled skills before it builds this list
 *   (same transaction as resolution), so the list is the whole truth for the run: kobe-sandbox-agent
 *   makes exactly these skills present and registers exactly these with Pi, and removes every
 *   other materialized skill.
 * - The bytes travel over HTTP on the server's **sandbox listener** (the port the sandbox
 *   NetworkPolicy already allows, same as workspace sync): `GET {@link SKILL_BUNDLE_PATH}/<sha256>`
 *   with the sandbox's `kobe.sandbox-wire` token in `Authorization: Bearer`. Sandboxes dial out
 *   only and **never hold object-store credentials, URLs or keys**: the server authenticates the
 *   caller, derives (team, user) from the token, serves the hash only while it is currently
 *   effective for that user in that team (approved, not blocklisted, personal skills not switched
 *   off), and streams the object, verifying the hash while it does. Anything else is a 404.
 * - kobe-sandbox-agent verifies size and SHA-256 against the frame before extracting, and extraction
 *   re-applies the bundle safety rules (safe paths, regular files only, size caps).
 *
 * Compatibility: `skill_bundles` is additive and optional. `config.skills` keeps listing the
 * skill names (now always equal to the names of `skill_bundles`). A sandbox agent that predates
 * this field rejects the frame (strict schema), so server and image roll out together.
 */
export const SKILL_BUNDLE_PATH = "/v1/sandbox/skills";

/** Largest canonical zip the sandbox accepts (uploads are capped at 25 MiB uncompressed). */
export const SKILL_BUNDLE_MAX_BYTES = 32 * 1024 * 1024;
/** Most skills per run (same cap as `config.skills`). */
export const SKILL_BUNDLES_MAX = 64;

export const skillBundleRefSchema = z.strictObject({
  name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  sha256: sha256HexSchema,
  size: z.number().int().positive().max(SKILL_BUNDLE_MAX_BYTES),
});
export type SkillBundleRef = z.infer<typeof skillBundleRefSchema>;
