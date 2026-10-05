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
 *   caller (sandbox, team, user from the token), serves the hash only if it is in the
 *   `skill_bundles` of a `run.start` still open on that very sandbox (the run is active, the
 *   command not yet answered) and not blocklisted right now, and streams the object, verifying the
 *   hash while it does. Anything else is a 404. The list was decided at run start, so a skill
 *   replaced or re-reviewed meanwhile does not break the run that was started with it.
 * - kobe-sandbox-agent verifies size and SHA-256 against the frame before extracting, and extraction
 *   re-applies the bundle safety rules (safe paths, regular files only, size caps).
 *
 * Compatibility: `skill_bundles` is additive and optional, omitted when empty. The server sends it
 * only to agents whose `hello.capabilities` lists {@link CAPABILITY_SKILL_BUNDLES}; a run that has
 * skills but sits on an agent without it fails (`skills_unsupported`) rather than starting without
 * them. `config.skills` keeps listing the names (equal to the names of `skill_bundles`). Agents
 * ignore unknown `config` fields from this change on.
 */
/** `hello.capabilities` entry of an agent that can materialize `config.skill_bundles`. */
export const CAPABILITY_SKILL_BUNDLES = "skill_bundles";

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

/**
 * Built-in (install-provided) skills (KOBE-88). The sandbox image bakes the gallery skills read-only
 * under `/opt/kobe/skills/<name>/` (root-owned, not writable by the agent, Pi or tool uids), so
 * there is nothing to fetch: `run.start.config.builtin_skills` lists the names of the built-ins the
 * run's effective skills include, and kobe-sandbox-agent registers exactly those with Pi
 * (`--skill <dir>`), never the unlisted ones. The server decides the list at run start (an agent
 * lists a built-in name like any skill); it is additive, optional and omitted when empty, and is
 * sent only to agents whose `hello.capabilities` lists {@link CAPABILITY_BUILTIN_SKILLS}: a run
 * that lists built-ins on an agent without it fails (`skills_unsupported`).
 */
export const CAPABILITY_BUILTIN_SKILLS = "builtin_skills";

/** The skills the sandbox image ships. These names are reserved: they never resolve to team skills. */
export const BUILTIN_SKILL_NAMES = [
  "data-analysis",
  "charts",
  "docx",
  "pdf",
  "xlsx",
  "code-review",
] as const;
export type BuiltinSkillName = (typeof BUILTIN_SKILL_NAMES)[number];

export function isBuiltinSkillName(name: string): name is BuiltinSkillName {
  return (BUILTIN_SKILL_NAMES as readonly string[]).includes(name);
}
