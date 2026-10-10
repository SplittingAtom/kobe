import { PROJECT_SLUG_MAX } from "@kobe/protocol";

/** A mount-folder slug from a project name: lowercase, digits, hyphens; never empty. */
export function deriveSlug(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, PROJECT_SLUG_MAX)
    .replace(/-+$/g, "");
  return slug === "" ? "project" : slug;
}

/** `base`, then `base-2` ... (kept within the slug length) for a derived slug that is taken. */
export function* slugCandidates(base: string, tries = 20): Generator<string> {
  yield base;
  for (let n = 2; n <= tries; n += 1) {
    const suffix = `-${n}`;
    yield `${base.slice(0, PROJECT_SLUG_MAX - suffix.length).replace(/-+$/g, "")}${suffix}`;
  }
}
