import {
  SCRIPT_RULES,
  pipesDownloadToInterpreter,
  SECRET_RULES,
  plausibleSecret,
} from "./rules.js";
import { extensionOf, fileTypeRule } from "./files.js";
import { INVISIBLE, PROSE_RULES } from "./prose.js";
import {
  RULE_SET_VERSION,
  SCAN_LIMITS,
  type Finding,
  type FindingCategory,
  type ScanFile,
  type ScanResult,
  type Severity,
  type Verdict,
} from "./types.js";

const SCRIPT_EXTENSIONS = new Set([
  "sh",
  "bash",
  "zsh",
  "ksh",
  "py",
  "js",
  "mjs",
  "cjs",
  "ts",
  "rb",
  "pl",
  "php",
  "ps1",
  "bat",
  "cmd",
]);
const BINARY_SNIFF_BYTES = 8000;

const extension = extensionOf;

function isScript(file: ScanFile): boolean {
  if (SCRIPT_EXTENSIONS.has(extension(file.path))) return true;
  return file.bytes[0] === 0x23 && file.bytes[1] === 0x21; // "#!"
}

function isBinary(bytes: Uint8Array): boolean {
  return bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0);
}

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

function scanLine(line: string, script: boolean, first: boolean): Array<[FindingCategory, string]> {
  const view = line.slice(0, SCAN_LIMITS.maxScanChars);
  const hits = new Map<FindingCategory, string>();
  // Prose rules run on every text file; one prose finding per line (the first rule that matches).
  const visible = first ? view.replace(/^\ufeff/, "") : view;
  const prose = INVISIBLE.test(visible)
    ? "invisible-unicode"
    : PROSE_RULES.find((r) => r.pattern.test(view))?.id;
  if (prose) hits.set("prose", prose);
  if (script) {
    if (line.length > SCAN_LIMITS.maxLineLength) hits.set("obfuscation", "long-line");
    if (pipesDownloadToInterpreter(view)) hits.set("pipe-to-shell", "fetch-pipe-exec");
    for (const rule of SCRIPT_RULES) {
      if (!hits.has(rule.category) && rule.pattern.test(view)) hits.set(rule.category, rule.id);
    }
  }
  const secret = matchSecret(view);
  if (secret) hits.set("secret", secret);
  return [...hits];
}

function scanFile(file: ScanFile, script: boolean, budget: number): Finding[] {
  const text = new TextDecoder("utf-8").decode(file.bytes);
  const findings: Finding[] = [];
  const limit = Math.min(SCAN_LIMITS.maxFindingsPerFile, budget);
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length && findings.length < limit; i++) {
    const line = lines[i] ?? "";
    for (const [category, rule] of scanLine(line, script, i === 0)) {
      if (findings.length >= limit) break;
      const view = line.slice(0, SCAN_LIMITS.maxScanChars);
      findings.push({
        category,
        rule,
        file: file.path,
        line: i + 1,
        excerpt: excerptOf(view),
        severity: "caution",
      });
    }
  }
  return findings;
}

/**
 * The verdict of a list of findings (stored ones too): Block if any blocks, Caution if any other,
 * Pass if none. A finding without a severity (stored before KOBE-312) counts as Caution.
 */
export function verdictOf(findings: readonly { readonly severity?: Severity | string }[]): Verdict {
  if (findings.length === 0) return "pass";
  return findings.some((f) => f.severity === "block") ? "block" : "caution";
}

/**
 * Statically scans a skill bundle, every file of it (hidden ones included). Pure: no I/O, bounded
 * work per file and per bundle. File types are checked for every file; text rules run on text
 * files within the size caps.
 */
export function scanSkillBundle(files: readonly ScanFile[]): ScanResult {
  const scripts = files
    .filter(isScript)
    .map((f) => f.path)
    .sort();
  const scriptSet = new Set(scripts);
  const skipped: string[] = [];
  const findings: Finding[] = [];
  let total = 0;
  for (const file of files) {
    const binary = isBinary(file.bytes);
    const typeRule = fileTypeRule(file.path, file.bytes, binary);
    if (typeRule && findings.length < SCAN_LIMITS.maxFindings) {
      findings.push({
        category: "file-type",
        rule: typeRule,
        file: file.path,
        line: 0,
        excerpt: "",
        severity: "block",
      });
      continue;
    }
    const tooBig = file.bytes.length > SCAN_LIMITS.maxFileBytes;
    if (tooBig || total + file.bytes.length > SCAN_LIMITS.maxTotalBytes || binary) {
      skipped.push(file.path);
      continue;
    }
    total += file.bytes.length;
    const budget = SCAN_LIMITS.maxFindings - findings.length;
    if (budget <= 0) continue;
    findings.push(...scanFile(file, scriptSet.has(file.path), budget));
  }
  return {
    verdict: verdictOf(findings),
    ruleSetVersion: RULE_SET_VERSION,
    scripts,
    findings,
    skipped,
  };
}
