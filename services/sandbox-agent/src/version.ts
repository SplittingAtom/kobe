import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";

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
