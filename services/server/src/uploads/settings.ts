import { z } from "zod";
import { UPLOAD_DEFAULT_MAX_FILE_BYTES, UPLOAD_DEFAULT_MAX_MESSAGE_BYTES } from "@kobe/protocol";

const GIB = 1024 * 1024 * 1024;

/** Default per-team storage quota when the team has none of its own (D26). */
export const DEFAULT_TEAM_STORAGE_QUOTA_BYTES = 10 * GIB;
/** How long an upload that never joined a thread is kept (hours). */
export const DEFAULT_ORPHAN_HOURS = 24;

const bytes = (name: string) =>
  z.coerce
    .number({ error: `${name} must be a number` })
    .int(`${name} must be an integer`)
    .min(1, `${name} must be at least 1`)
    .max(Number.MAX_SAFE_INTEGER, `${name} is too large`);

/** Defaults for the optional clamd connection (chart `clamav.*`). */
export const DEFAULT_CLAMD_PORT = 3310;
export const DEFAULT_CLAMD_TIMEOUT_MS = 60_000;

const schema = z.object({
  /** Set by the chart when `clamav.enabled`; absent = no scanning. */
  KOBE_CLAMAV_HOST: z.string().trim().min(1, "KOBE_CLAMAV_HOST must not be empty").optional(),
  KOBE_CLAMAV_PORT: z.coerce
    .number({ error: "KOBE_CLAMAV_PORT must be a number" })
    .int("KOBE_CLAMAV_PORT must be an integer")
    .min(1, "KOBE_CLAMAV_PORT must be a port")
    .max(65535, "KOBE_CLAMAV_PORT must be a port")
    .default(DEFAULT_CLAMD_PORT),
  KOBE_CLAMAV_TIMEOUT_MS: z.coerce
    .number({ error: "KOBE_CLAMAV_TIMEOUT_MS must be a number" })
    .int("KOBE_CLAMAV_TIMEOUT_MS must be an integer")
    .min(1000, "KOBE_CLAMAV_TIMEOUT_MS must be between 1000 and 600000")
    .max(600_000, "KOBE_CLAMAV_TIMEOUT_MS must be between 1000 and 600000")
    .default(DEFAULT_CLAMD_TIMEOUT_MS),
  KOBE_UPLOAD_MAX_FILE_BYTES: bytes("KOBE_UPLOAD_MAX_FILE_BYTES").default(
    UPLOAD_DEFAULT_MAX_FILE_BYTES,
  ),
  KOBE_UPLOAD_MAX_MESSAGE_BYTES: bytes("KOBE_UPLOAD_MAX_MESSAGE_BYTES").default(
    UPLOAD_DEFAULT_MAX_MESSAGE_BYTES,
  ),
  KOBE_TEAM_STORAGE_QUOTA_BYTES: bytes("KOBE_TEAM_STORAGE_QUOTA_BYTES").default(
    DEFAULT_TEAM_STORAGE_QUOTA_BYTES,
  ),
  KOBE_UPLOAD_ORPHAN_HOURS: z.coerce
    .number({ error: "KOBE_UPLOAD_ORPHAN_HOURS must be a number" })
    .int("KOBE_UPLOAD_ORPHAN_HOURS must be an integer")
    .min(1, "KOBE_UPLOAD_ORPHAN_HOURS must be between 1 and 720")
    .max(720, "KOBE_UPLOAD_ORPHAN_HOURS must be between 1 and 720")
    .default(DEFAULT_ORPHAN_HOURS),
});

export interface UploadSettings {
  /** Largest single file (`file_too_large`). */
  readonly maxFileBytes: number;
  /** Largest message total (`message_too_large`); also bounds a single file. */
  readonly maxMessageBytes: number;
  /** Team storage limit when `team_storage_quotas` has no value for the team. */
  readonly defaultQuotaBytes: number;
  /** Hours before an upload without a thread is deleted. */
  readonly orphanHours: number;
  /**
   * clamd to scan every upload with (KOBE-146). Absent: scanning is off (`scan: skipped`). When
   * present the scan fails closed: clamd unreachable = `scan_unavailable`, never an unscanned file.
   */
  readonly clamav?: { readonly host: string; readonly port: number; readonly timeoutMs: number };
}

export const DEFAULT_UPLOAD_SETTINGS: UploadSettings = {
  maxFileBytes: UPLOAD_DEFAULT_MAX_FILE_BYTES,
  maxMessageBytes: UPLOAD_DEFAULT_MAX_MESSAGE_BYTES,
  defaultQuotaBytes: DEFAULT_TEAM_STORAGE_QUOTA_BYTES,
  orphanHours: DEFAULT_ORPHAN_HOURS,
};

/** Upload limits from the environment (Helm); invalid values fail the start, naming the variable. */
export function loadUploadSettings(
  env: Readonly<Record<string, string | undefined>>,
): UploadSettings {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const e = parsed.data;
  return {
    maxFileBytes: e.KOBE_UPLOAD_MAX_FILE_BYTES,
    maxMessageBytes: e.KOBE_UPLOAD_MAX_MESSAGE_BYTES,
    defaultQuotaBytes: e.KOBE_TEAM_STORAGE_QUOTA_BYTES,
    orphanHours: e.KOBE_UPLOAD_ORPHAN_HOURS,
    ...(e.KOBE_CLAMAV_HOST
      ? {
          clamav: {
            host: e.KOBE_CLAMAV_HOST,
            port: e.KOBE_CLAMAV_PORT,
            timeoutMs: e.KOBE_CLAMAV_TIMEOUT_MS,
          },
        }
      : {}),
  };
}
