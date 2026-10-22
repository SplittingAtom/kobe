import { z } from "zod";

/**
 * Governed import (KOBE-344, spec SK30): a Builder imports a git repository at a commit SHA, or a
 * zip URL pinned by its SHA-256, from a Site-allowlisted host (and owner). The server fetches it
 * through the egress proxy, re-hashes what it got and creates a Workbench draft that records the
 * origin; nothing is fetched again (at run time or ever) and a ref or branch name is never taken.
 * The result is a draft, never a catalog entry: evals, a version, review or promotion follow.
 */

/** https, the default port, no credentials, query or fragment (tokens travel there). */
export const importUrlSchema = z
  .url({ protocol: /^https$/ })
  .max(2048)
  .refine((s) => {
    const u = new URL(s);
    return (
      u.username === "" &&
      u.password === "" &&
      u.port === "" &&
      u.search === "" &&
      u.hash === "" &&
      !s.includes("?") &&
      !s.includes("#")
    );
  }, "an https URL on the default port, without credentials, query or fragment");

/** A full commit id: SHA-1 (40 hex) or SHA-256 (64 hex) repositories. Never a branch or tag. */
export const importCommitSchema = z
  .string()
  .regex(/^([0-9a-f]{40}|[0-9a-f]{64})$/, "a full commit SHA (40 or 64 hex characters)");

/** A folder inside the repository holding the skill (`skills/pdf`); empty: the repository root. */
export const importPathSchema = z
  .string()
  .max(200)
  .regex(/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/, "a folder path such as skills/pdf")
  .refine((p) => p.split("/").every((s) => s !== "." && s !== ".."), "no . or .. folders");

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, "a SHA-256 in lowercase hex");

/** `POST /v1/skills/drafts/import`. */
export const skillImportRequestSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("git"),
    url: importUrlSchema,
    commit: importCommitSchema,
    path: importPathSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("zip"),
    url: importUrlSchema,
    /** The zip's SHA-256: what is imported is pinned, as a git commit pins a repository. */
    sha256: sha256Schema,
  }),
]);
export type SkillImportRequest = z.infer<typeof skillImportRequestSchema>;

/**
 * `skill_drafts.origin`: where an imported draft came from. `fetchedSha256` is Kobe's own hash of
 * what it fetched (a zip's bytes; for git, the canonical zip of the imported files).
 */
export const skillImportOriginSchema = z.strictObject({
  kind: z.enum(["git", "zip"]),
  url: importUrlSchema,
  commit: importCommitSchema.optional(),
  path: importPathSchema.optional(),
  fetchedSha256: sha256Schema,
  importedBy: z.uuid(),
  importedAt: z.iso.datetime(),
});
export type SkillImportOrigin = z.infer<typeof skillImportOriginSchema>;

/**
 * Whether `url` is allowed by the Site's import allowlist: an entry `host` allows that exact
 * host, an entry `host/owner` only URLs whose first path segment is that owner (case-insensitive,
 * as the big git hosts treat owners). Subdomains are never implied.
 */
export function importAllowed(allowlist: readonly string[], url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.port !== "") return false;
  const host = u.hostname.toLowerCase();
  const owner = (u.pathname.split("/")[1] ?? "").toLowerCase();
  return allowlist.some((entry) => {
    const [h, o] = entry.split("/");
    return h === host && (o === undefined || (owner !== "" && o === owner));
  });
}
