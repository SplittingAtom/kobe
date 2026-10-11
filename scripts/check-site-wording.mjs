#!/usr/bin/env node
// KOBE-257: "Site" replaced "Install" as the name of the scope (Site console, site admin, this
// site). This check fails when text people read in apps/*, services/* or packages/* still calls the
// scope "install". "install" stays only where it means installing (helm install, the installation
// guide) and in identifiers, which KOBE-255 renames. Comments are skipped; each file's text is
// whitespace-normalised first, so prose wrapped over lines ("an install\n admin") still matches.
// Runs from the repo root in `pnpm verify` and CI (not a package test, so turbo never caches it).
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const AREAS = ["apps", "services", "packages"];
const SKIP_DIRS = new Set(["node_modules", "dist", ".next", ".turbo", "coverage", "drizzle"]);
const SOURCE = /\.(ts|tsx|mts|mjs|js)$/;
const TEST = /\.(test|spec)\.[a-z]+$|\/testing\//;

const APOSTROPHE = "(?:'|’|&apos;|&rsquo;|&#39;)";
const NOUNS =
  "admins?|owners?|roles?|console|floor|ceiling|catalog|budgets?|maximum|invitations?|invites?|" +
  "policy|rules?|settings|deny|registry|default|log|scope|key|blocklist|report|level";
const SCOPE_WORDING = [
  new RegExp(`\\binstall (?:${NOUNS})\\b`, "i"),
  new RegExp(`\\binstall${APOSTROPHE}s\\b`, "i"),
  /\b(?:this|your|that|each|every|one|per) (?:kobe )?install\b/i,
  /\b(?:a|an|the) (?:new|fresh|test|existing|throwaway|large|single-admin|real) install\b/i,
  /\bsingle-admin install\b/i,
  /\binstall-(?:wide|level)\b/i,
  /\bthe install (?:has|keeps|allows|is|was|caps|runs|offers)\b/i,
  />\s*Install\s*</, // bare JSX text, e.g. <h2>Install</h2>
  /(["'`])Install \1|(["'`])Install\2/, // a label: "Install" or a prefix "Install "
];

/** Drops comments (block, JSX and line comments; not `//` inside URLs) and collapses whitespace. */
export function readableText(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1")
    .replace(/\s+/g, " ");
}

export function findings(source) {
  const text = readableText(source);
  return SCOPE_WORDING.flatMap((re) => {
    const m = text.match(re);
    return m ? [text.slice(Math.max(0, m.index - 40), m.index + m[0].length + 40).trim()] : [];
  });
}

function selfTest() {
  const bad = [
    "<p>ask an install\n          admin to add domains.</p>",
    "<h2 id='x'>Install</h2>",
    'message: "That model is not in the install’s catalog."',
    "`${tool.name} is blocked by install policy.`",
    '"not allowed by this Kobe install."',
    "<p>a fresh install reaches nothing</p>",
    'prefix="Install "',
  ];
  const good = [
    "// an install admin, in a comment",
    "/* the install's ceiling */ const x = 1;",
    'run <code>helm install</code> first, see "https://example.com/install"',
    'scope: "install", requireInstallPermission("install.users.manage")',
    "Install gVisor on every node (scripts/install-gvisor-k3s.sh)",
  ];
  const missed = bad.filter((s) => findings(s).length === 0);
  const flagged = good.filter((s) => findings(s).length > 0);
  if (missed.length || flagged.length) {
    console.error("site wording: self-test failed", { missed, flagged });
    process.exit(2);
  }
}

function sources(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    if (SKIP_DIRS.has(d.name) || d.name.startsWith(".")) return [];
    const path = join(dir, d.name);
    if (d.isDirectory()) return sources(path);
    return SOURCE.test(d.name) && !TEST.test(path) ? [path] : [];
  });
}

selfTest();
const hits = AREAS.flatMap((area) => sources(join(ROOT, area))).flatMap((file) =>
  findings(readFileSync(file, "utf8")).map((at) => `${relative(ROOT, file)}: …${at}…`),
);
if (hits.length > 0) {
  console.error(hits.join("\n"));
  console.error(
    `error: ${hits.length} place(s) call the scope "install"; say "site" (KOBE-257). ` +
      "Keep install only for installing (helm install, the installation guide).",
  );
  process.exit(1);
}
console.log("site wording: ok");
