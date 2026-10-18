export type FindingCategory =
  | "network"
  | "pipe-to-shell"
  | "package-install"
  | "obfuscation"
  | "secret"
  /** KOBE-312: a file type outside the allowlist (Block). */
  | "file-type"
  /** KOBE-312: prose that steers the model, hides text or installs prerequisites (Caution). */
  | "prose";

/**
 * How bad a finding is (KOBE-312, spec SK32). `caution`: a reviewer must acknowledge it before
 * approving. `block`: the version is unusable unless a Site admin overrides (audited).
 */
export type Severity = "caution" | "block";

/** The scan's verdict: the worst severity among its findings, or `pass` with none. */
export type Verdict = "pass" | Severity;

/**
 * The rule set the findings come from. Bump it whenever a rule, its severity or a limit changes:
 * stored scans from another rule set are rescanned (SK32).
 */
export const RULE_SET_VERSION = "2026.10.18";

export interface ScanFile {
  readonly path: string;
  readonly bytes: Uint8Array;
}

export interface Finding {
  readonly category: FindingCategory;
  readonly file: string;
  /** 1-based line number. */
  readonly line: number;
  /** The offending line, secrets masked, truncated. */
  readonly excerpt: string;
  /** Short rule id, e.g. `curl`, `aws-access-key`. */
  readonly rule: string;
  readonly severity: Severity;
}

export interface ScanResult {
  readonly verdict: Verdict;
  readonly ruleSetVersion: string;
  /** Paths of files treated as scripts (by extension or shebang), sorted. */
  readonly scripts: readonly string[];
  readonly findings: readonly Finding[];
  /** Files not read for text rules: binary, or over a size cap (the file-type rules still ran). */
  readonly skipped: readonly string[];
}

export const SCAN_LIMITS = {
  /** Files larger than this are skipped. */
  maxFileBytes: 1024 * 1024,
  /** Bundle bytes scanned in total; later files are skipped. */
  maxTotalBytes: 20 * 1024 * 1024,
  /** A script line longer than this is itself flagged as obfuscation. */
  maxLineLength: 1000,
  /** Regexes only ever see this many characters of a line. */
  maxScanChars: 2000,
  maxExcerptLength: 200,
  maxFindingsPerFile: 50,
  maxFindings: 500,
} as const;
