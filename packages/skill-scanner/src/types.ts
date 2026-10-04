export type FindingCategory =
  "network" | "pipe-to-shell" | "package-install" | "obfuscation" | "secret";

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
}

export interface ScanResult {
  /** Paths of files treated as scripts (by extension or shebang), sorted. */
  readonly scripts: readonly string[];
  readonly findings: readonly Finding[];
  /** Files not scanned because they are binary or exceed a size cap. */
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
