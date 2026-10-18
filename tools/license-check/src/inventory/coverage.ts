/**
 * Finds the third-party images the repository pulls (Dockerfile FROM lines, the chart, dev
 * manifests, CI workflows and scripts) and the chart's top-level value keys, so a new image or
 * service without an inventory entry fails the check.
 */
import { parse } from "yaml";

export interface ImageRef {
  /** Normalised repository: no tag or digest, no docker.io/library or Docker Hub mirror prefix. */
  readonly repository: string;
  readonly ref: string;
  readonly at: string;
}

/** Kobe's own images; their contents are inventoried through the tables above. */
const FIRST_PARTY = /^ghcr\.io\/splittingatom\//;
const DOCKER_HUB = /^(?:docker\.io|index\.docker\.io|registry-1\.docker\.io|mirror\.gcr\.io)\//;

export function normaliseImage(ref: string): string {
  let repo = ref.replace(/@sha256:[0-9a-f]+$/, "");
  const lastSlash = repo.lastIndexOf("/");
  const colon = repo.indexOf(":", lastSlash + 1);
  if (colon !== -1) repo = repo.slice(0, colon);
  repo = repo.replace(DOCKER_HUB, "");
  return repo.replace(/^library\//, "");
}

function substitute(value: string, args: ReadonlyMap<string, string>): string {
  return value.replace(
    /\$\{(\w+)\}|\$(\w+)/g,
    (_m, a: string | undefined, b: string | undefined) => {
      return args.get((a ?? b) as string) ?? "";
    },
  );
}

/** FROM images of a Dockerfile, with ARG defaults substituted; build stages are skipped. */
export function dockerfileImages(text: string, file: string): ImageRef[] {
  const args = new Map<string, string>();
  const stages = new Set<string>();
  const found: ImageRef[] = [];
  text.split("\n").forEach((line, i) => {
    const arg = /^\s*ARG\s+(\w+)=("?)([^"\s]*)\2\s*$/i.exec(line);
    if (arg) args.set(arg[1] as string, arg[3] as string);
    const from = /^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?/i.exec(line);
    if (!from) return;
    const ref = substitute(from[1] as string, args);
    const isStage = stages.has(ref.toLowerCase());
    if (from[2]) stages.add(from[2].toLowerCase());
    if (ref === "scratch" || isStage) return;
    found.push({ repository: normaliseImage(ref), ref, at: `${file}:${i + 1}` });
  });
  return found;
}

const LITERAL = /^[a-z0-9][\w./-]*(?::[\w.-]+)?(?:@sha256:[0-9a-f]{64})?$/;

const PATTERNS: readonly RegExp[] = [
  // YAML keys: image:, imageName:, repository: (chart values, dev manifests, workflow services).
  /^\s*(?:-\s*)?(?:image|imageName|repository):\s*["']?([^\s"'#]+)/,
  // Helm template dict literals: "repository" "docker.io/...".
  /"repository"\s+"([^"]+)"/,
  // buildx driver options and kubectl/k3d flags: image=..., --image=..., --image ...
  /(?:^|[\s,])(?:--)?image[= ]["']?([^\s"',]+)/,
  // JSON pod specs inside shell scripts: \"image\":\"busybox:1.37\".
  /\\?"image\\?":\s*\\?"([^"\\]+)/,
  // Image defaults in shell scripts: K3S_IMAGE="${K3S_IMAGE:-rancher/k3s:v1.34.6-k3s1}".
  /_IMAGE:-([^}"\s]+)\}/,
  // docker run [--flag]... image:tag
  /docker run\s+(?:--?[\w-]+(?:=\S+)?\s+)*([a-z0-9][\w./-]*:[\w.-]+)/,
];

/** Literal image references in YAML, Helm templates and shell scripts (variables are skipped). */
export function textImages(text: string, file: string): ImageRef[] {
  const found: ImageRef[] = [];
  text.split("\n").forEach((line, i) => {
    if (/^\s*#/.test(line)) return;
    for (const pattern of PATTERNS) {
      const global = new RegExp(pattern.source, "g");
      for (const match of line.matchAll(global)) {
        const ref = match[1] as string;
        if (!LITERAL.test(ref) || !/[:/]/.test(ref)) continue;
        found.push({ repository: normaliseImage(ref), ref, at: `${file}:${i + 1}` });
      }
    }
  });
  return found;
}

export function thirdParty(refs: readonly ImageRef[]): ImageRef[] {
  return refs.filter((r) => !FIRST_PARTY.test(r.ref) && !FIRST_PARTY.test(`${r.repository}/`));
}

/** Image references no inventory row covers. */
export function uncoveredImages(
  refs: readonly ImageRef[],
  covered: ReadonlySet<string>,
): ImageRef[] {
  return thirdParty(refs).filter((r) => !covered.has(r.repository));
}

export function chartValueKeys(valuesYaml: string): string[] {
  return Object.keys((parse(valuesYaml) ?? {}) as Record<string, unknown>);
}

/** Keys missing from chartValues, and chartValues entries for keys the chart no longer has. */
export function chartValueDrift(
  keys: readonly string[],
  classified: Readonly<Record<string, unknown>>,
): { missing: string[]; stale: string[] } {
  return {
    missing: keys.filter((k) => !(k in classified)),
    stale: Object.keys(classified).filter((k) => !keys.includes(k)),
  };
}
