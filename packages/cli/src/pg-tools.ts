import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";

export type PgTool = "pg_dump" | "pg_restore" | "psql";

/** Binary path: `binDir/name` when KOBE_PG_BIN_DIR is set, otherwise looked up on PATH. */
export function pgBinary(name: PgTool, binDir?: string): string {
  return binDir ? join(binDir, name) : name;
}

export interface LibpqConnection {
  /** Connection URI for `--dbname`, without the password. */
  readonly dbname: string;
  /** Environment carrying the password, so it never appears in a process listing. */
  readonly env: Readonly<Record<string, string>>;
}

export function libpqConnection(databaseUrl: string): LibpqConnection {
  const url = new URL(databaseUrl);
  if (url.password === "") return { dbname: databaseUrl, env: {} };
  const password = decodeURIComponent(url.password);
  url.password = "";
  return { dbname: url.toString(), env: { PGPASSWORD: password } };
}

export interface PgVersion {
  readonly major: number;
  readonly minor: number;
}

export function parseVersion(versionOutput: string): PgVersion {
  const match = /\(PostgreSQL\)\s+(\d+)(?:\.(\d+))?/.exec(versionOutput);
  if (!match?.[1]) {
    throw new Error(`Unrecognized PostgreSQL version output: ${versionOutput.trim()}`);
  }
  return { major: Number(match[1]), minor: Number(match[2] ?? 0) };
}

export function parseMajorVersion(versionOutput: string): number {
  return parseVersion(versionOutput).major;
}

/**
 * pg_restore 17.6+/18 wraps its script in `\restrict <random key>`, so psql refuses meta-commands
 * (e.g. `\!`) that a crafted archive might carry. Restore requires it.
 */
export function supportsRestrict(v: PgVersion): boolean {
  return v.major > 17 || (v.major === 17 && v.minor >= 6);
}

const PASSED_ENV = ["PATH", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "LC_MESSAGES", "TMPDIR", "TZ"];

/**
 * Environment for client tools: OS basics and libpq's own PG* settings only. S3 credentials, the
 * backup key and anything else in the parent environment stay out of child processes.
 */
export function childEnv(
  parent: Readonly<Record<string, string | undefined>>,
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(parent)) {
    if (value !== undefined && (PASSED_ENV.includes(key) || key.startsWith("PG"))) env[key] = value;
  }
  return { ...env, ...extra };
}

/**
 * Error lines of pg_dump / pg_restore without their `detail:` lines, which can quote row data
 * (failed values, COPY commands). Bounded so a pathological stderr can't flood the terminal.
 */
export function safeToolErrors(stderr: string): string {
  return stderr
    .split("\n")
    .filter((l) => /\berror:|FATAL/.test(l) && !/\bdetail:/.test(l))
    .slice(0, 10)
    .join("\n");
}

/**
 * psql runs with VERBOSITY=verbose (so ERROR lines carry the SQLSTATE) and SHOW_CONTEXT=never.
 * Kobe's own checks (P0001 "kobe restore: …") are shown in full; any other server error only as
 * its SQLSTATE, because messages, DETAIL and CONTEXT can quote row data. Client-side errors
 * (connection, invalid meta-command) are shown.
 */
export function safePsqlErrors(stderr: string): string {
  const out: string[] = [];
  for (const line of stderr.split("\n")) {
    const server = /(ERROR|FATAL):\s+([0-9A-Z]{5}):\s*(.*)$/.exec(line);
    if (server) {
      const [, level, code, message = ""] = server;
      out.push(
        code === "P0001" && message.startsWith("kobe restore:")
          ? message
          : `${level} ${code} (message withheld: it can contain row data; see the Postgres server log)`,
      );
    } else if (/^psql(:<stdin>:\d+:)?:? error:/.test(line)) {
      out.push(line);
    }
  }
  return out.slice(0, 10).join("\n");
}

export interface SpawnOptions {
  readonly env?: Readonly<Record<string, string>>;
}

/** Spawns a client tool with a minimal environment (`childEnv`) plus `env`; all stdio piped. */
export function spawnTool(
  binary: string,
  args: readonly string[],
  options: SpawnOptions = {},
): ChildProcess {
  return spawn(binary, args, {
    env: childEnv(process.env, options.env),
    stdio: ["pipe", "pipe", "pipe"],
  });
}

/** Collects stderr (bounded) and resolves with the exit code; rejects if the binary is missing. */
export function waitForExit(
  child: ChildProcess,
  binary: string,
): Promise<{ code: number; stderr: string }> {
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    if (stderr.length < 64_000) stderr += chunk.toString("utf8");
  });
  return new Promise((resolve, reject) => {
    child.once("error", (err: NodeJS.ErrnoException) => {
      reject(
        err.code === "ENOENT"
          ? new Error(
              `${binary} not found: install the PostgreSQL client (17.6 or newer) or set KOBE_PG_BIN_DIR`,
            )
          : err,
      );
    });
    child.once("close", (code) => resolve({ code: code ?? 1, stderr }));
  });
}

/** Runs a tool to completion; on failure reports only its error lines (`safeToolErrors`). */
export async function runTool(
  binary: string,
  args: readonly string[],
  options: SpawnOptions = {},
): Promise<string> {
  const child = spawnTool(binary, args, options);
  child.stdin?.end();
  let stdout = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  const { code, stderr } = await waitForExit(child, binary);
  if (code !== 0) throw new Error(`${binary} failed (exit ${code}): ${safeToolErrors(stderr)}`);
  return stdout;
}

/**
 * Checks that a client tool exists and is at least the server's major version (pg_dump refuses
 * newer servers); with `needRestrict`, also that it supports `\restrict` (17.6+).
 */
export async function checkToolVersion(
  binary: string,
  serverMajor: number,
  needRestrict = false,
): Promise<string> {
  const output = (await runTool(binary, ["--version"])).trim();
  const version = parseVersion(output);
  if (version.major < serverMajor) {
    throw new Error(
      `${binary} is PostgreSQL ${version.major}; the server is ${serverMajor}. Install a PostgreSQL ${serverMajor}+ client or set KOBE_PG_BIN_DIR`,
    );
  }
  if (needRestrict && !supportsRestrict(version)) {
    throw new Error(
      `${binary} is PostgreSQL ${version.major}.${version.minor}; restore needs 17.6 or newer (\\restrict support)`,
    );
  }
  return output;
}
