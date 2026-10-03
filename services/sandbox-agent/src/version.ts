import { execFile } from "node:child_process";
import { access, readFile, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";

const PI_PACKAGE = "@earendil-works/pi-coding-agent";

/** The agent's own version, from the package manifest shipped next to `dist/`. */
export async function readAgentVersion(manifestUrl: URL): Promise<string> {
  try {
    const manifest = JSON.parse(await readFile(manifestUrl, "utf8")) as { version?: unknown };
    return typeof manifest.version === "string" && manifest.version !== ""
      ? manifest.version.slice(0, 64)
      : "unknown";
  } catch {
    return "unknown";
  }
}

/** `pi --version` of the installed Pi (the server refuses anything outside 1.0.x). */
export function detectPiVersion(
  bin: string,
  env: Readonly<Record<string, string>>,
): Promise<string> {
  return new Promise((resolve) => {
    execFile(bin, ["--version"], { timeout: 15_000, env: { ...env } }, (error, stdout) => {
      const match = /(\d+\.\d+\.\d+[\w.+-]*)/.exec(String(stdout));
      resolve(error === null && match?.[1] !== undefined ? match[1].slice(0, 64) : "unknown");
    });
  });
}

/**
 * Pi's version from the package that ships the `pi` binary (resolved through PATH and symlinks),
 * without starting Pi: `pi --version` boots Node and Pi's bundle, about a second under gVisor, on
 * every sandbox start (cold-start path, D14). Falls back to `pi --version`.
 */
export async function piVersion(
  bin: string,
  env: Readonly<Record<string, string>>,
): Promise<string> {
  const fromPackage = await readPiPackageVersion(bin, env.PATH ?? "").catch(() => undefined);
  return fromPackage ?? detectPiVersion(bin, env);
}

async function readPiPackageVersion(bin: string, path: string): Promise<string | undefined> {
  let resolved: string | undefined;
  if (isAbsolute(bin)) resolved = bin;
  else {
    for (const dir of path.split(delimiter).filter(Boolean)) {
      const candidate = join(dir, bin);
      if (
        await access(candidate, constants.X_OK).then(
          () => true,
          () => false,
        )
      ) {
        resolved = candidate;
        break;
      }
    }
  }
  if (!resolved) return undefined;
  let dir = dirname(await realpath(resolved));
  for (let i = 0; i < 8; i++) {
    const manifest = await readFile(join(dir, "package.json"), "utf8").then(
      (t) => JSON.parse(t) as { name?: unknown; version?: unknown },
      () => undefined,
    );
    if (manifest?.name === PI_PACKAGE && typeof manifest.version === "string") {
      const match = /^(\d+\.\d+\.\d+[\w.+-]*)$/.exec(manifest.version);
      return match?.[1]?.slice(0, 64);
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}
