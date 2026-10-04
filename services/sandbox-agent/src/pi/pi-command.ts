import { constants } from "node:fs";
import { access, open, realpath } from "node:fs/promises";
import path from "node:path";

/**
 * How Pi is executed (KOBE-71 review, HIGH 1a). Pi is a Node script (`#!/usr/bin/env node`) and
 * Pi 1.0.0 installs no SIGUSR1 handler, so a SIGUSR1 from a tool (which runs as Pi's uid) would
 * open Node's inspector inside Pi: code execution next to kobe-policy and its socket. Pi's
 * environment already carries `NODE_OPTIONS=--disable-sigusr1` (pi-launch.ts); the agent also
 * runs the script itself as `node --disable-sigusr1 <script>`, so the flag does not depend on the
 * environment reaching Node. Nothing else can turn the inspector on from outside: Pi's
 * environment is the agent's allow-list (no other NODE_OPTIONS), and its arguments are the
 * agent's.
 */
export interface PiCommand {
  readonly bin: string;
  /** Arguments before Pi's own (`--disable-sigusr1 <script>` for a Node script). */
  readonly prefix: readonly string[];
}

const NODE_SHEBANG = /^#!\s*\S*(?:\/env\s+(?:-\S+\s+)*)?\S*\bnode\b/;

async function findInPath(bin: string, pathEnv: string | undefined): Promise<string | undefined> {
  for (const dir of (pathEnv ?? "").split(":")) {
    if (dir === "") continue;
    const candidate = path.join(dir, bin);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // next
    }
  }
  return undefined;
}

async function isNodeScript(file: string): Promise<boolean> {
  if (/\.(?:c|m)?js$/.test(file)) return true;
  const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const head = Buffer.alloc(128);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    const firstLine = head.subarray(0, bytesRead).toString("utf8").split("\n")[0] ?? "";
    return NODE_SHEBANG.test(firstLine);
  } finally {
    await handle.close();
  }
}

/** Pi's command: the Node script run by this agent's Node with `--disable-sigusr1`, else `bin`. */
export async function piCommand(
  bin: string,
  pathEnv: string | undefined,
  node: string = process.execPath,
): Promise<PiCommand> {
  const file = bin.includes("/") ? bin : await findInPath(bin, pathEnv);
  if (file === undefined) return { bin, prefix: [] };
  let script: string;
  try {
    script = await realpath(file);
    if (!(await isNodeScript(script))) return { bin: file, prefix: [] };
  } catch {
    return { bin: file, prefix: [] }; // spawning it fails visibly (pi_unavailable)
  }
  return { bin: node, prefix: ["--disable-sigusr1", script] };
}
