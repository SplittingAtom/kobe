import { readFileSync } from "node:fs";
import { parseArgs, type ParseArgsOptionsConfig } from "node:util";
import { z } from "zod";
import { parseKeyMaterial } from "./crypto.js";

export const USAGE = `Usage:
  kobe backup  --out <new directory> [--no-objects]
  kobe restore --from <backup directory> [--allow-object-mismatch] [--no-objects]

Environment:
  both     KOBE_BACKUP_KEY_FILE      file with the backup key (openssl rand -base64 32), or
           KOBE_BACKUP_KEY           the key itself; encrypts and signs backups. Keep it safe:
                                     without it a backup cannot be restored
  backup   KOBE_BACKUP_DATABASE_URL  role with BYPASSRLS (or superuser) that can read every table
  restore  KOBE_DB_MIGRATE_URL       the owner role (the chart's migrate-url), never the app role
  both     KOBE_S3_BUCKET, KOBE_S3_ENDPOINT, KOBE_S3_REGION, KOBE_S3_PREFIX,
           KOBE_S3_FORCE_PATH_STYLE, KOBE_S3_ACCESS_KEY_ID, KOBE_S3_SECRET_ACCESS_KEY
           KOBE_PG_BIN_DIR           directory with pg_dump, pg_restore and psql (default: PATH)

See docs/backup-restore.md.`;

export interface S3Settings {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly prefix: string;
  readonly forcePathStyle: boolean;
  /** Absent: the AWS SDK's default credential chain. */
  readonly credentials: { readonly accessKeyId: string; readonly secretAccessKey: string } | null;
}

export interface BackupCommand {
  readonly command: "backup";
  readonly out: string;
  readonly databaseUrl: string;
  readonly s3: S3Settings | null;
  readonly pgBinDir: string | undefined;
  readonly key: Buffer;
}

export interface RestoreCommand {
  readonly command: "restore";
  readonly from: string;
  readonly databaseUrl: string;
  readonly s3: S3Settings | null;
  /** Proceed although bucket objects are missing or differ from the backup's listing. */
  readonly allowObjectMismatch: boolean;
  /** Skip object verification entirely (operator passed --no-objects). */
  readonly skipObjects: boolean;
  readonly pgBinDir: string | undefined;
  readonly key: Buffer;
}

export type Command = BackupCommand | RestoreCommand;

type Env = Readonly<Record<string, string | undefined>>;

const postgresUrl = (name: string) =>
  z
    .url({ protocol: /^postgres(ql)?$/, error: `${name} must be a postgres:// URL` })
    .refine(
      (u) => !new URL(u).searchParams.has("password"),
      "put the password in the user-info part (postgres://user:password@host), not in ?password=",
    );

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", ""]);
const TLS_MODES = new Set(["require", "verify-ca", "verify-full"]);

/** A warning when a remote database is reached without TLS required (null when fine). */
export function tlsWarning(databaseUrl: string): string | null {
  const url = new URL(databaseUrl);
  if (LOCAL_HOSTS.has(url.hostname) || url.searchParams.has("host")) return null;
  const mode = url.searchParams.get("sslmode") ?? "";
  if (TLS_MODES.has(mode)) return null;
  return `WARNING: ${url.hostname} is reached without sslmode=require (or verify-full); backup data and credentials may cross the network unencrypted`;
}

const s3Schema = z.object({
  KOBE_S3_ENDPOINT: z
    .union([z.literal(""), z.url({ protocol: /^https?$/ })])
    .refine(
      (u) => u === "" || (new URL(u).username === "" && new URL(u).password === ""),
      "must not contain credentials (use KOBE_S3_ACCESS_KEY_ID / KOBE_S3_SECRET_ACCESS_KEY)",
    )
    .default(""),
  KOBE_S3_REGION: z.string().min(1).default("us-east-1"),
  KOBE_S3_BUCKET: z.string().min(1).max(255),
  KOBE_S3_PREFIX: z.string().max(1024).default(""),
  KOBE_S3_FORCE_PATH_STYLE: z.enum(["true", "false"]).default("true"),
  KOBE_S3_ACCESS_KEY_ID: z.string().min(1).optional(),
  KOBE_S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
});

/** Messages name the setting only, never its value (secrets must not reach logs). */
function fail(error: z.ZodError): never {
  const issues = error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
  throw new Error(`Invalid configuration: ${issues}`);
}

function readS3(env: Env): S3Settings | null {
  if (!env.KOBE_S3_BUCKET) return null;
  const parsed = s3Schema.safeParse(env);
  if (!parsed.success) fail(parsed.error);
  const s = parsed.data;
  if (Boolean(s.KOBE_S3_ACCESS_KEY_ID) !== Boolean(s.KOBE_S3_SECRET_ACCESS_KEY)) {
    throw new Error(
      "Invalid configuration: set both KOBE_S3_ACCESS_KEY_ID and KOBE_S3_SECRET_ACCESS_KEY, or neither",
    );
  }
  return {
    endpoint: s.KOBE_S3_ENDPOINT,
    region: s.KOBE_S3_REGION,
    bucket: s.KOBE_S3_BUCKET,
    prefix: s.KOBE_S3_PREFIX,
    forcePathStyle: s.KOBE_S3_FORCE_PATH_STYLE === "true",
    credentials:
      s.KOBE_S3_ACCESS_KEY_ID && s.KOBE_S3_SECRET_ACCESS_KEY
        ? { accessKeyId: s.KOBE_S3_ACCESS_KEY_ID, secretAccessKey: s.KOBE_S3_SECRET_ACCESS_KEY }
        : null,
  };
}

function readUrl(env: Env, name: string): string {
  const parsed = z.object({ [name]: postgresUrl(name) }).safeParse(env);
  if (!parsed.success) fail(parsed.error);
  return parsed.data[name] as string;
}

/** The operator's backup key: from a file or the environment, never from the command line. */
export function readBackupKey(env: Env, readKeyFile: (path: string) => string): Buffer {
  const file = env.KOBE_BACKUP_KEY_FILE;
  const value = env.KOBE_BACKUP_KEY;
  if (file && value) {
    throw new Error("Invalid configuration: set KOBE_BACKUP_KEY_FILE or KOBE_BACKUP_KEY, not both");
  }
  if (!file && !value) {
    throw new Error(
      "Invalid configuration: backups are always encrypted and signed; set KOBE_BACKUP_KEY_FILE (or KOBE_BACKUP_KEY) to a key from `openssl rand -base64 32`",
    );
  }
  let text: string;
  try {
    text = file ? readKeyFile(file) : (value as string);
  } catch {
    throw new Error("Invalid configuration: KOBE_BACKUP_KEY_FILE could not be read");
  }
  try {
    return parseKeyMaterial(text);
  } catch (err) {
    throw new Error(
      `Invalid configuration: ${file ? "KOBE_BACKUP_KEY_FILE" : "KOBE_BACKUP_KEY"}: ${(err as Error).message}`,
      { cause: err },
    );
  }
}

function usageError(message: string): Error {
  return new Error(`${message}\n\n${USAGE}`);
}

function parseFlags(args: readonly string[], options: ParseArgsOptionsConfig) {
  try {
    return parseArgs({ args: [...args], options, strict: true, allowPositionals: false }).values;
  } catch (err) {
    throw usageError((err as Error).message);
  }
}

export function parseCommand(
  argv: readonly string[],
  env: Env,
  readKeyFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
): Command {
  const [command, ...rest] = argv;
  const pgBinDir = env.KOBE_PG_BIN_DIR || undefined;
  if (command === "backup") {
    const flags = parseFlags(rest, {
      out: { type: "string" },
      "no-objects": { type: "boolean", default: false },
    });
    if (typeof flags.out !== "string" || flags.out === "")
      throw usageError("backup needs --out <dir>");
    const s3 = readS3(env);
    if (!s3 && flags["no-objects"] !== true) {
      throw usageError(
        "Object storage is not configured: set KOBE_S3_BUCKET (and KOBE_S3_ENDPOINT, credentials), or pass --no-objects to back up Postgres only",
      );
    }
    return {
      command,
      out: flags.out,
      databaseUrl: readUrl(env, "KOBE_BACKUP_DATABASE_URL"),
      s3: flags["no-objects"] === true ? null : s3,
      pgBinDir,
      key: readBackupKey(env, readKeyFile),
    };
  }
  if (command === "restore") {
    const flags = parseFlags(rest, {
      from: { type: "string" },
      "allow-object-mismatch": { type: "boolean", default: false },
      "no-objects": { type: "boolean", default: false },
    });
    if (typeof flags.from !== "string" || flags.from === "") {
      throw usageError("restore needs --from <dir>");
    }
    return {
      command,
      from: flags.from,
      databaseUrl: readUrl(env, "KOBE_DB_MIGRATE_URL"),
      s3: flags["no-objects"] === true ? null : readS3(env),
      allowObjectMismatch: flags["allow-object-mismatch"] === true,
      skipObjects: flags["no-objects"] === true,
      pgBinDir,
      key: readBackupKey(env, readKeyFile),
    };
  }
  throw usageError(command ? `Unknown command "${command}"` : "No command given");
}
