import {
  SCRIPT_RULES,
  pipesDownloadToInterpreter,
  SECRET_RULES,
  plausibleSecret,
} from "./rules.js";
import { INVISIBLE, PROSE_RULES } from "./prose.js";
import { SCAN_LIMITS, type Finding, type FindingCategory } from "./types.js";

/**
 * Text rules over one file, line by line. A line longer than the scan window is read in
 * overlapping windows, so content far along a long line is still matched (KOBE-312 review B1);
 * every regex only ever sees one window.
 */
const WINDOW_OVERLAP = 200;

function maskValue(value: string): string {
  const keep = Math.min(4, Math.floor(value.length / 4));
  return value.slice(0, keep) + "*".repeat(Math.max(value.length - keep, 4));
}

/** Masks every secret-shaped value so excerpts never carry one. */
function maskSecrets(text: string): string {
  return SECRET_RULES.reduce((acc, rule) => {
    const global = new RegExp(rule.pattern.source, rule.pattern.flags + "g");
    return acc.replace(global, (match: string, ...rest: unknown[]) => {
      const value = rule.group === 0 ? match : String(rest[rule.group - 1]);
      return match.replace(value, maskValue(value));
    });
  }, text);
}

function excerptOf(view: string): string {
  const masked = maskSecrets(view).trim();
  const max = SCAN_LIMITS.maxExcerptLength;
  return masked.length > max ? masked.slice(0, max) + "…" : masked;
}

function matchSecret(view: string): string | undefined {
  for (const rule of SECRET_RULES) {
    const m = rule.pattern.exec(view);
    if (!m) continue;
    if (rule.group === 0 || plausibleSecret(m[rule.group] ?? "")) return rule.id;
  }
  return undefined;
}

function* windows(line: string): Generator<string> {
  const size = SCAN_LIMITS.maxScanChars;
  if (line.length <= size) {
    yield line;
    return;
  }
  for (let at = 0; at < line.length; at += size - WINDOW_OVERLAP) {
    yield line.slice(at, at + size);
    if (at + size >= line.length) return;
  }
}

type Hit = readonly [FindingCategory, string, string];

/** Rules matching one window of a line: [category, rule]; the first rule per category wins. */
function windowHits(view: string, script: boolean, hits: Map<FindingCategory, Hit>): void {
  const add = (category: FindingCategory, rule: string | undefined) => {
    if (rule && !hits.has(category)) hits.set(category, [category, rule, view]);
  };
  if (!hits.has("prose")) add("prose", PROSE_RULES.find((r) => r.pattern.test(view))?.id);
  // Piping a download into an interpreter is worth a look in any text file; the other script
  // rules (network, installs, obfuscation) would be noise in prose and run on scripts only.
  if (pipesDownloadToInterpreter(view)) add("pipe-to-shell", "fetch-pipe-exec");
  for (const rule of SCRIPT_RULES)
    if ((script || rule.category === "pipe-to-shell") && rule.pattern.test(view))
      add(rule.category, rule.id);
  if (!hits.has("secret")) add("secret", matchSecret(view));
}

function lineHits(line: string, script: boolean, first: boolean): Hit[] {
  const hits = new Map<FindingCategory, Hit>();
  // Invisible characters first: one prose finding per line. A leading BOM is allowed.
  const visible = first ? line.replace(/^\ufeff/, "") : line;
  if (INVISIBLE.test(visible)) hits.set("prose", ["prose", "invisible-unicode", line]);
  if (script && line.length > SCAN_LIMITS.maxLineLength)
    hits.set("obfuscation", ["obfuscation", "long-line", line]);
  for (const view of windows(line)) windowHits(view, script, hits);
  return [...hits.values()];
}

export interface TextScan {
  readonly findings: Finding[];
  /** A cap cut this file's findings short. */
  readonly truncated: boolean;
}

/** Caution findings of one text file, at most `budget` (and the per-file cap). */
export function scanText(path: string, text: string, script: boolean, budget: number): TextScan {
  const findings: Finding[] = [];
  const limit = Math.min(SCAN_LIMITS.maxFindingsPerFile, budget);
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    for (const [category, rule, view] of lineHits(lines[i] ?? "", script, i === 0)) {
      if (findings.length >= limit) return { findings, truncated: true };
      findings.push({
        category,
        rule,
        file: path,
        line: i + 1,
        excerpt: excerptOf(view.slice(0, SCAN_LIMITS.maxScanChars)),
        severity: "caution",
      });
    }
  }
  return { findings, truncated: false };
}
