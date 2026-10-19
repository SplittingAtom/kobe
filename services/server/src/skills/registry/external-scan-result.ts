import { sql, type KobeDb, type KobeTx } from "@kobe/db";
import { z } from "zod";

/**
 * The external scanner's result (KOBE-341, SK32) as the server keeps it in the version's scan
 * document (`scan.external`). Findings are advisory: a MEDIUM, HIGH or CRITICAL finding becomes a
 * Caution finding (acknowledged one by one before Approve, like Kobe's own) and can raise a Pass
 * verdict to Caution; LOW and INFO findings are shown for information. Block stays Kobe's own
 * decision: nothing here ever sets it.
 */
export const SCAN_MARKER = "KOBE_EXTERNAL_SCAN ";
/** External rules are named apart from Kobe's own (`cisco:<rule id>`). */
export const EXTERNAL_RULE_PREFIX = "cisco:";
const RAISING = new Set(["medium", "high", "critical"]);

const findingSchema = z.object({
  ruleId: z.string().min(1).max(120),
  severity: z.enum(["critical", "high", "medium", "low", "info"]),
  category: z.string().max(80).nullable().optional(),
  title: z.string().max(200),
  file: z.string().max(300).nullable().optional(),
  line: z.number().int().min(0).nullable().optional(),
});

const resultSchema = z.object({
  v: z.literal(1),
  scanner: z.string().min(1).max(80),
  version: z.string().min(1).max(40),
  findings: z.array(findingSchema).max(200).optional(),
  truncated: z.boolean().optional(),
  error: z.string().max(40).optional(),
});

export interface ExternalFinding {
  readonly rule: string;
  readonly file: string;
  readonly line: number;
  /** `caution` (needs an acknowledgement) or `info` (shown only). */
  readonly severity: "caution" | "info";
  /** The scanner's own severity. */
  readonly externalSeverity: string;
  readonly category: string | null;
  readonly title: string;
}

export type ExternalScan =
  | { readonly status: "queued"; readonly queuedAt: string }
  | { readonly status: "running"; readonly startedAt: string; readonly job: string }
  | {
      readonly status: "done";
      readonly scanner: string;
      readonly version: string;
      readonly findings: readonly ExternalFinding[];
      readonly truncated: boolean;
      readonly startedAt: string | null;
      readonly finishedAt: string;
    }
  | {
      readonly status: "failed" | "skipped" | "unavailable";
      readonly reason: string;
      readonly finishedAt: string;
    };

/** The result line in the pod's log, reduced to what Kobe keeps; a failure when there is none. */
export function parseScanLog(
  log: string,
  at: { readonly startedAt: string | null; readonly finishedAt: string },
): ExternalScan {
  const line = log
    .split("\n")
    .reverse()
    .find((l) => l.startsWith(SCAN_MARKER));
  if (!line) return { status: "failed", reason: "no_result", finishedAt: at.finishedAt };
  let parsed: z.infer<typeof resultSchema>;
  try {
    const result = resultSchema.safeParse(JSON.parse(line.slice(SCAN_MARKER.length)));
    if (!result.success)
      return { status: "failed", reason: "bad_result", finishedAt: at.finishedAt };
    parsed = result.data;
  } catch {
    return { status: "failed", reason: "bad_result", finishedAt: at.finishedAt };
  }
  if (parsed.error) return { status: "failed", reason: parsed.error, finishedAt: at.finishedAt };
  return {
    status: "done",
    scanner: parsed.scanner,
    version: parsed.version,
    truncated: parsed.truncated ?? false,
    startedAt: at.startedAt,
    finishedAt: at.finishedAt,
    findings: (parsed.findings ?? []).map((f) => ({
      rule: `${EXTERNAL_RULE_PREFIX}${f.ruleId}`,
      file: f.file ?? "",
      line: f.line ?? 0,
      severity: RAISING.has(f.severity) ? "caution" : "info",
      externalSeverity: f.severity,
      category: f.category ?? null,
      title: f.title,
    })),
  };
}

/** The scan isn't finished: Approve waits (`external_scan_running`). */
export const PENDING_STATUSES: ReadonlySet<string> = new Set(["queued", "running"]);
/** The scan ended without a result: a Caution item the reviewer acknowledges (review M2). */
const INCOMPLETE_STATUSES: ReadonlySet<string> = new Set(["failed", "skipped", "unavailable"]);
export const INCOMPLETE_RULE = `${EXTERNAL_RULE_PREFIX}scan_incomplete`;

export const queuedScan = (now: Date): ExternalScan => ({
  status: "queued",
  queuedAt: now.toISOString(),
});

/** Is the Site's external scanner on (inside the submission's transaction)? */
export async function externalScannerOn(tx: KobeDb | KobeTx): Promise<boolean> {
  const r = await tx.execute<{ on: boolean | null }>(sql`
    SELECT (scanner ->> 'external')::boolean AS on FROM site_skill_settings WHERE id = 1`);
  return r.rows[0]?.on === true;
}

/** The one Caution item of a scan that didn't complete: why, for the reviewer to weigh. */
function incompleteFinding(reason: unknown): ExternalFinding {
  return {
    rule: INCOMPLETE_RULE,
    file: "",
    line: 0,
    severity: "caution",
    externalSeverity: "incomplete",
    category: null,
    title: `The external scan did not complete (${String(reason ?? "unknown").slice(0, 40)}): judge the package without it.`,
  };
}

/**
 * The verdict after the external scan: Pass rises to Caution on a MEDIUM-or-higher finding, or
 * when the scan did not complete (review M2); never Block.
 */
export function raisedVerdict(verdict: string, scan: ExternalScan): string {
  const raises =
    (scan.status === "done" && scan.findings.some((f) => f.severity === "caution")) ||
    INCOMPLETE_STATUSES.has(scan.status);
  return raises && verdict === "pass" ? "caution" : verdict;
}

/**
 * The external scan's findings as the review shows them: its own, or the one "incomplete" item
 * when it failed, was skipped or couldn't run (review M2).
 */
export function externalFindings(scan: Record<string, unknown>): readonly ExternalFinding[] {
  const ext = scan.external as
    { status?: unknown; findings?: unknown; reason?: unknown } | undefined;
  if (!ext || typeof ext.status !== "string") return [];
  if (INCOMPLETE_STATUSES.has(ext.status)) return [incompleteFinding(ext.reason)];
  if (ext.status !== "done" || !Array.isArray(ext.findings)) return [];
  return ext.findings as ExternalFinding[];
}

/** The external Caution findings stored in a scan document (for acknowledgements). */
export function externalCautionFindings(scan: Record<string, unknown>): readonly ExternalFinding[] {
  return externalFindings(scan).filter((f) => f.severity === "caution");
}
