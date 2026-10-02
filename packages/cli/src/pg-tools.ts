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

export function parseMajorVersion(versionOutput: string): number {
  const match = /\(PostgreSQL\)\s+(\d+)/.exec(versionOutput);
  if (!match?.[1])
    throw new Error(`Unrecognized PostgreSQL version output: ${versionOutput.trim()}`);
  return Number(match[1]);
}

export interface SpawnOptions {
  readonly env?: Readonly<Record<string, string>>;
}

/** Spawns a client tool with the caller's environment plus `env`; stdout/stderr are piped. */
export function spawnTool(
  binary: string,
  args: readonly string[],
  options: SpawnOptions = {},
): ChildProcess {
  return spawn(binary, args, {
    env: { ...process.env, ...options.env },
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
              `${binary} not found: install the PostgreSQL client (17 or newer) or set KOBE_PG_BIN_DIR`,
            )
          : err,
      );
    });
    child.once("close", (code) => resolve({ code: code ?? 1, stderr }));
  });
}

/** Runs a tool to completion, failing with its stderr on a non-zero exit. */
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
  if (code !== 0) throw new Error(`${binary} failed (exit ${code}): ${stderr.trim()}`);
  return stdout;
}

/** Checks that a client tool exists and is at least `minMajor` (pg_dump refuses newer servers). */
export async function checkToolVersion(binary: string, minMajor: number): Promise<string> {
  const output = (await runTool(binary, ["--version"])).trim();
  const major = parseMajorVersion(output);
  if (major < minMajor) {
    throw new Error(
      `${binary} is PostgreSQL ${major}; the server is ${minMajor}. Install a PostgreSQL ${minMajor}+ client or set KOBE_PG_BIN_DIR`,
    );
  }
  return output;
}
