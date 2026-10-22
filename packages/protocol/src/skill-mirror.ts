import { z } from "zod";

/**
 * The catalog's optional one-way git mirror (KOBE-343, spec SK29, U36). Each approved catalog
 * version becomes a commit under `skills/<name>/` (the package layout, with Kobe's
 * `provenance.json`) and an annotated tag `<name>/v<semver>`, and `catalog.json` at the root is
 * regenerated. Kobe only appends: never a rewrite or a force-push, and it never reads the mirror
 * back as a source.
 */

/** A version's tag in the mirror. */
export const mirrorTagName = (name: string, semver: string): string => `${name}/v${semver}`;

const instant = z.iso.datetime({ offset: true });
const sha1 = z.string().regex(/^[0-9a-f]{40}$/);

/**
 * `registry_versions.mirror`: one version's state against the configured remote (`url`). A new
 * remote URL makes every version pending again (the new remote gets the whole catalog).
 */
export const registryVersionMirrorSchema = z.strictObject({
  url: z.string().max(512),
  /**
   * `withdrawn`: on the site skill blocklist. Never pushed (again), and left out of `catalog.json`
   * from the next commit on; a commit or tag already pushed stays (Kobe never rewrites history).
   */
  status: z.enum(["pushed", "failed", "withdrawn"]),
  /** The commit whose `skills/<name>/` tree is this version, and the tag object naming it. */
  commit: sha1.optional(),
  tag: z.string().max(200).optional(),
  /** The git tree of `skills/<name>/`: the package files, byte for byte. */
  tree: sha1.optional(),
  pushedAt: instant.optional(),
  /** Failed attempts since the last success (backoff). */
  attempts: z.number().int().min(0),
  lastError: z.string().max(500).optional(),
  lastAttemptAt: instant,
  nextAttemptAt: instant.optional(),
});
export type RegistryVersionMirror = z.infer<typeof registryVersionMirrorSchema>;

/** One version the mirror could not push yet (newest failures first). */
export interface SkillMirrorFailure {
  readonly registryVersionId: string;
  readonly name: string;
  readonly semver: string;
  readonly attempts: number;
  readonly lastError: string;
  readonly lastAttemptAt: string;
  readonly nextAttemptAt: string | null;
}

/** `GET /v1/site/skills/registry/mirror`: what the Site console shows. */
export interface SkillMirrorStatus {
  readonly enabled: boolean;
  readonly url: string | null;
  readonly branch: string;
  /**
   * Whether this server can push at all: the egress proxy is configured and the token Secret is
   * mounted. `missing` names what is not.
   */
  readonly ready: boolean;
  readonly missing: readonly ("token" | "egress_proxy")[];
  /** The remote's host is in the site egress ceiling (pushes go through the egress proxy). */
  readonly hostInCeiling: boolean | null;
  readonly pushed: number;
  /** Published versions on the site skill blocklist: not mirrored, not listed in catalog.json. */
  readonly withdrawn: number;
  readonly pending: number;
  readonly failed: number;
  readonly lastPushedAt: string | null;
  readonly failures: readonly SkillMirrorFailure[];
}
