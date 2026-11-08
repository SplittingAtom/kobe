import {
  EGRESS_HOST_PATTERN,
  LICENSE_PATTERN,
  MANIFEST_API_VERSION,
  MANIFEST_MAX_BYTES,
  MAX_EGRESS_HOSTS,
  MAX_PACKAGES_PER_MANAGER,
  MAX_TAGS,
  PACKAGE_SPEC_PATTERN,
  SUMMARY_MAX_CHARS,
  TAG_PATTERN,
  kobeSkillManifestSchema,
  type KobeSkillManifest,
} from "@kobe/protocol";
import { stringify } from "yaml";
import { readManifest } from "../bundle.js";

/**
 * From a model's reply to a `kobe.skill.yaml` the package contract accepts (KOBE-564). The reply
 * is untrusted text: the one JSON object in it is read leniently, every field is cleaned to the
 * contract's rules or dropped, and the fields the model never decides come from the version
 * (`apiVersion`, `name`, `version`) and the author (`license`). The result always validates
 * against `kobeSkillManifestSchema`; a reply with nothing usable gives the seed alone.
 */

export interface ManifestSeed {
  readonly name: string;
  readonly semver: string;
  /** SKILL.md's `description`: the summary when the model gives none. */
  readonly description: string;
  /** The author's choice (an SPDX expression or `Proprietary`); never the model's. */
  readonly license?: string | undefined;
}

/** Control and format characters, line separators: never in a one-line summary. */
const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/** One line, plain, within the contract's length (cut at a word when it can be). */
export function cleanSummary(text: string, max = SUMMARY_MAX_CHARS): string {
  const flat = text.replace(UNSAFE, " ").replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const head = flat.slice(0, max - 1);
  const atWord = head.lastIndexOf(" ");
  return `${atWord > max / 2 ? head.slice(0, atWord) : head}…`;
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

const unique = (values: readonly string[], max: number): string[] =>
  [...new Set(values)].slice(0, max);

/** Topic slugs the contract takes; unknown ones are proposals, so they stay. */
export function cleanTags(value: unknown): string[] {
  return unique(
    strings(value)
      .map((t) => t.trim().toLowerCase())
      .filter((t) => TAG_PATTERN.test(t)),
    MAX_TAGS,
  );
}

/** A host from a host, a URL or `host:port`; null when it is not an exact lowercase host. */
function hostOf(value: string): string | null {
  let host = value.trim().toLowerCase();
  if (host.includes("://")) {
    try {
      host = new URL(host).hostname;
    } catch {
      return null;
    }
  }
  host = host.replace(/\/.*$/, "").replace(/:\d+$/, "");
  return EGRESS_HOST_PATTERN.test(host) ? host : null;
}

export function cleanEgress(value: unknown): string[] {
  return unique(
    strings(value).flatMap((v) => {
      const host = hostOf(v);
      return host === null ? [] : [host];
    }),
    MAX_EGRESS_HOSTS,
  );
}

export function cleanPackages(value: unknown): string[] {
  return unique(
    strings(value)
      .map((p) => p.trim())
      .filter((p) => p !== "" && !/\s/.test(p) && PACKAGE_SPEC_PATTERN.test(p)),
    MAX_PACKAGES_PER_MANAGER,
  );
}

/**
 * The first JSON object in a reply: the whole text, or the text of its first fenced block, or the
 * outermost `{ … }` in it. Null when none parses to an object.
 */
export function jsonObjectIn(reply: string): Record<string, unknown> | null {
  const candidates = [reply.trim()];
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(reply);
  if (fence?.[1]) candidates.push(fence[1].trim());
  const first = reply.indexOf("{");
  const last = reply.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(reply.slice(first, last + 1));
  for (const text of candidates) {
    try {
      const value: unknown = JSON.parse(text);
      if (typeof value === "object" && value !== null && !Array.isArray(value))
        return value as Record<string, unknown>;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** The manifest the seed alone gives: SKILL.md's description as the summary. */
export function manifestFromSeed(seed: ManifestSeed): KobeSkillManifest {
  return kobeSkillManifestSchema.parse({
    apiVersion: MANIFEST_API_VERSION,
    name: seed.name,
    version: seed.semver,
    summary: cleanSummary(seed.description) || seed.name,
    ...(seed.license !== undefined && LICENSE_PATTERN.test(seed.license)
      ? { license: seed.license }
      : {}),
  });
}

export interface ParsedManifest {
  readonly manifest: KobeSkillManifest;
  /** Whether the reply held a JSON object the manifest took fields from. */
  readonly fromModel: boolean;
}

/**
 * The manifest a reply describes, over the seed. Only `summary`, `tags` and `capabilities` are
 * read; each is cleaned to the contract or dropped. `compatibility` and `changelog` are not
 * taken: the save writes the changelog, and the model knows no version ranges.
 */
export function manifestFromReply(reply: string, seed: ManifestSeed): ParsedManifest {
  const base = manifestFromSeed(seed);
  const json = jsonObjectIn(reply);
  if (!json) return { manifest: base, fromModel: false };
  const summary = typeof json.summary === "string" ? cleanSummary(json.summary) : "";
  const tags = cleanTags(json.tags);
  const capabilities = record(json.capabilities);
  const egress = cleanEgress(capabilities.egress);
  const packages = record(capabilities.packages);
  const pip = cleanPackages(packages.pip);
  const npm = cleanPackages(packages.npm);
  const caps = {
    ...(egress.length > 0 ? { egress } : {}),
    ...(pip.length > 0 || npm.length > 0
      ? { packages: { ...(pip.length > 0 ? { pip } : {}), ...(npm.length > 0 ? { npm } : {}) } }
      : {}),
  };
  const candidate = {
    ...base,
    ...(summary !== "" ? { summary } : {}),
    ...(tags.length > 0 ? { tags } : {}),
    ...(Object.keys(caps).length > 0 ? { capabilities: caps } : {}),
  };
  const parsed = kobeSkillManifestSchema.safeParse(candidate);
  return parsed.success
    ? { manifest: parsed.data, fromModel: true }
    : { manifest: base, fromModel: false };
}

export class ManifestYamlError extends Error {
  constructor(message: string) {
    super(`kobe.skill.yaml: ${message}`);
    this.name = "ManifestYamlError";
  }
}

/** The manifest's keys in the order the built-in skills write them. */
const KEY_ORDER: readonly (keyof KobeSkillManifest)[] = [
  "apiVersion",
  "name",
  "version",
  "summary",
  "tags",
  "license",
  "maintainers",
  "capabilities",
  "compatibility",
  "changelog",
];

/**
 * The manifest as the YAML bytes a package carries, checked the way an upload reads them
 * (`readManifest`: text rules, schema, the name). Throws when they would not be accepted.
 */
export function manifestYaml(manifest: KobeSkillManifest): Uint8Array {
  const ordered = Object.fromEntries(
    KEY_ORDER.filter((k) => manifest[k] !== undefined).map((k) => [k, manifest[k]]),
  );
  const bytes = new TextEncoder().encode(stringify(ordered, { lineWidth: 0 }));
  if (bytes.length > MANIFEST_MAX_BYTES)
    throw new ManifestYamlError("larger than the contract allows");
  const back = readManifest(bytes, manifest.name);
  if (!back.ok) throw new ManifestYamlError(back.error.message);
  if (back.value?.version !== manifest.version)
    throw new ManifestYamlError("the version did not survive serialisation");
  return bytes;
}
