import { extensionOf, fileTypeRule, isAssetExtension } from "./files.js";
import { INVISIBLE } from "./prose.js";
import { isScript, runReferences } from "./scripts.js";
import { scanText } from "./text.js";
import {
  RULE_SET_VERSION,
  SCAN_LIMITS,
  type Finding,
  type ScanFile,
  type ScanResult,
  type Severity,
  type Verdict,
} from "./types.js";

const isBinary = (bytes: Uint8Array): boolean => bytes.includes(0);
const decode = (bytes: Uint8Array) => new TextDecoder("utf-8").decode(bytes);

const fileFinding = (
  path: string,
  category: Finding["category"],
  rule: string,
  severity: Severity,
): Finding => ({ category, rule, file: path, line: 0, excerpt: "", severity });

/**
 * The verdict of a list of findings (stored ones too): Block if any blocks, Caution if any other,
 * Pass if none. A finding without a severity (stored before KOBE-312) counts as Caution.
 */
export function verdictOf(findings: readonly { readonly severity?: Severity | string }[]): Verdict {
  if (findings.length === 0) return "pass";
  return findings.some((f) => f.severity === "block") ? "block" : "caution";
}

/**
 * The verdict of a stored scan. Before KOBE-312 the scanner skipped binaries and oversized files
 * without a finding, so a stored row whose `skipped` names a file that no finding covers and that
 * is not an allowed asset (by extension) reads as Caution, never Pass (review S5). For every scan
 * made since, this equals its `verdict`.
 */
export function storedVerdict(scan: {
  readonly findings: readonly { readonly severity?: Severity | string; readonly file?: string }[];
  readonly skipped?: readonly string[];
}): Verdict {
  const verdict = verdictOf(scan.findings);
  if (verdict !== "pass") return verdict;
  const unexplained = (scan.skipped ?? []).some((p) => !isAssetExtension(extensionOf(p)));
  return unexplained ? "caution" : "pass";
}

interface Collected {
  readonly blocks: Finding[];
  readonly cautions: Finding[];
  readonly skipped: string[];
  /** Where a cap first cut findings short, if anywhere. */
  truncatedAt?: string;
}

/** The final list: Block findings first, then Caution, capped; a cut is recorded as a finding. */
function capped(c: Collected): Finding[] {
  const all = [...c.blocks, ...c.cautions];
  const max = SCAN_LIMITS.maxFindings;
  const cut = all.length > max;
  const truncatedAt = c.truncatedAt ?? (cut ? all[max - 1]?.file : undefined);
  if (truncatedAt === undefined) return all;
  const kept = all.slice(0, max - 1);
  // The marker carries the worst tier that was dropped, so the verdict never softens.
  const lostBlock = all.slice(max - 1).some((f) => f.severity === "block");
  return [
    ...kept,
    fileFinding(truncatedAt, "limit", "findings-truncated", lostBlock ? "block" : "caution"),
  ];
}

/**
 * Statically scans a skill bundle, every file of it (hidden ones included). Pure: no I/O, bounded
 * work per file and per bundle. File types are checked for every file; text rules run on every
 * text file within the size caps, and a file the caps keep from being read is itself Block, so
 * bulk never buys a Pass. Block findings are never dropped by the findings cap.
 */
export function scanSkillBundle(files: readonly ScanFile[]): ScanResult {
  const c: Collected = { blocks: [], cautions: [], skipped: [] };
  const texts = new Map<string, string>();
  let total = 0;
  let budgetHit = false;
  for (const file of files) {
    if (INVISIBLE.test(file.path))
      c.cautions.push(fileFinding(file.path, "prose", "invisible-unicode-path", "caution"));
    const binary = isBinary(file.bytes);
    const typeRule = fileTypeRule(file.path, file.bytes, binary);
    if (typeRule) {
      c.blocks.push(fileFinding(file.path, "file-type", typeRule, "block"));
      continue;
    }
    if (binary) {
      c.skipped.push(file.path); // an allowed asset
      continue;
    }
    if (file.bytes.length > SCAN_LIMITS.maxFileBytes) {
      c.blocks.push(fileFinding(file.path, "limit", "oversized-file", "block"));
      c.skipped.push(file.path);
      continue;
    }
    if (total + file.bytes.length > SCAN_LIMITS.maxTotalBytes) {
      if (!budgetHit) c.blocks.push(fileFinding(file.path, "limit", "scan-incomplete", "block"));
      budgetHit = true;
      c.skipped.push(file.path);
      continue;
    }
    total += file.bytes.length;
    texts.set(file.path, decode(file.bytes));
  }
  const refs = runReferences(texts.values());
  const scripts = files
    .filter((f) => texts.has(f.path) && isScript(f, refs))
    .map((f) => f.path)
    .sort();
  const scriptSet = new Set(scripts);
  for (const [path, text] of texts) {
    const budget = SCAN_LIMITS.maxFindings - c.cautions.length;
    if (budget <= 0) {
      c.truncatedAt ??= path;
      continue;
    }
    const r = scanText(path, text, scriptSet.has(path), budget);
    c.cautions.push(...r.findings);
    if (r.truncated) c.truncatedAt ??= path;
  }
  const findings = capped(c);
  return {
    verdict: verdictOf(findings),
    ruleSetVersion: RULE_SET_VERSION,
    scripts,
    findings,
    skipped: c.skipped,
  };
}
