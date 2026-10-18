import { RULE_SET_VERSION, type ScanResult } from "@kobe/skill-scanner";
import type { Logger } from "pino";
import type { BlobStore } from "../retention/blobs.js";
import { IntegrityError, readVerified } from "./blob-read.js";
import { scanCanonicalZip } from "./review.js";

/**
 * Reading and scanning stored bundles for a rescan (KOBE-313), with a cache bounded by bytes:
 * a personal version reviewed in several teams is read and scanned once while it stays in the
 * cache (least recently used goes first). Only the scan result is kept, never the bytes.
 */
export const RESCAN_CACHE_BYTES = 16 * 1024 * 1024;

/** A rough size of a scan result in memory (findings dominate). */
function sizeOf(scan: ScanResult): number {
  const findings = scan.findings.reduce(
    (n, f) => n + 2 * (f.excerpt.length + f.file.length + f.rule.length) + 128,
    0,
  );
  const paths = [...scan.scripts, ...scan.skipped].reduce((n, p) => n + 2 * p.length + 32, 0);
  return findings + paths + 256;
}

export class ScanCache {
  private readonly entries = new Map<string, { scan: ScanResult; bytes: number }>();
  private total = 0;
  constructor(private readonly maxBytes = RESCAN_CACHE_BYTES) {}

  get(key: string): ScanResult | undefined {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    // Re-insert: Map order is the recency order.
    this.entries.delete(key);
    this.entries.set(key, hit);
    return hit.scan;
  }

  set(key: string, scan: ScanResult): void {
    const bytes = sizeOf(scan);
    if (bytes > this.maxBytes) return;
    const old = this.entries.get(key);
    if (old) {
      this.total -= old.bytes;
      this.entries.delete(key);
    }
    this.entries.set(key, { scan, bytes });
    this.total += bytes;
    for (const [k, v] of this.entries) {
      if (this.total <= this.maxBytes) break;
      this.entries.delete(k);
      this.total -= v.bytes;
    }
  }

  /** Bytes held (tests). */
  get size(): number {
    return this.total;
  }
}

/** A stored bundle as its version row names it. */
export interface StoredBundle {
  readonly storageKey: string;
  readonly packageStorageKey: string | null;
  readonly contentHash: string;
  readonly packageHash: string | null;
  readonly sizeBytes: number;
}

/**
 * The scan of a stored bundle that fails its integrity check (tampered or corrupt): Block, so an
 * approved version holding it is suspended and its people are told.
 */
export function integrityScan(): ScanResult {
  return {
    verdict: "block",
    ruleSetVersion: RULE_SET_VERSION,
    scripts: [],
    findings: [
      {
        category: "limit",
        rule: "bundle-integrity",
        file: "SKILL.md",
        line: 0,
        excerpt: "The stored bundle does not match its recorded hash.",
        severity: "block",
      },
    ],
    skipped: [],
  };
}

/**
 * Scans a stored version's whole package (or its runtime zip), verified. Null when the object is
 * missing or the scan fails (logged with its context: retried by the next pass); an integrity
 * failure is logged as an error and scans as Block `bundle-integrity`.
 */
export async function scanStored(
  deps: { readonly blobs: BlobStore; readonly log: Pick<Logger, "warn" | "error"> },
  v: StoredBundle,
  cache: ScanCache,
  context: Readonly<Record<string, unknown>>,
): Promise<ScanResult | null> {
  const key = v.packageStorageKey ?? v.storageKey;
  const cached = cache.get(key);
  if (cached) return cached;
  try {
    const bytes =
      v.packageStorageKey && v.packageHash
        ? await readVerified(deps.blobs, v.packageStorageKey, v.packageHash, null)
        : await readVerified(deps.blobs, v.storageKey, v.contentHash, v.sizeBytes);
    if (!bytes) {
      deps.log.warn({ ...context, key }, "skills: rescan found no stored bundle; retried later");
      return null;
    }
    const scan = await scanCanonicalZip(bytes);
    cache.set(key, scan);
    return scan;
  } catch (err) {
    if (err instanceof IntegrityError) {
      deps.log.error(
        { ...context, key, reason: err.reason },
        "skills: stored bundle failed its integrity check; the version is blocked",
      );
      return integrityScan();
    }
    deps.log.warn(
      { ...context, key, err },
      "skills: rescan of a stored bundle failed; retried later",
    );
    return null;
  }
}
