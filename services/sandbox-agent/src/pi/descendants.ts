import { readFileSync, readdirSync } from "node:fs";

/**
 * Best-effort list of a process's descendants from /proc (Linux; empty elsewhere). Pi starts its
 * tools in their own process groups (`detached`), so killing Pi's group does not reach them; the
 * agent walks the ppid tree while Pi is still alive (afterwards orphans are re-parented to PID 1 and
 * can no longer be attributed). Bounded by the process table; never throws.
 */
export function descendantPids(root: number, procDir = "/proc"): number[] {
  let entries: string[];
  try {
    entries = readdirSync(procDir);
  } catch {
    return [];
  }
  const children = new Map<number, number[]>();
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const ppid = parentOf(`${procDir}/${entry}/stat`);
    if (ppid === undefined) continue;
    const list = children.get(ppid) ?? [];
    list.push(Number(entry));
    children.set(ppid, list);
  }
  const found: number[] = [];
  const queue = [root];
  while (queue.length > 0) {
    const pid = queue.shift() as number;
    for (const child of children.get(pid) ?? []) {
      if (found.includes(child) || child === root) continue;
      found.push(child);
      queue.push(child);
    }
  }
  return found;
}

function parentOf(statFile: string): number | undefined {
  try {
    const stat = readFileSync(statFile, "utf8");
    // "pid (comm) state ppid ..." — comm may contain spaces and parentheses.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const ppid = Number(fields[1]);
    return Number.isInteger(ppid) ? ppid : undefined;
  } catch {
    return undefined;
  }
}

export function killPids(pids: readonly number[]): void {
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
}
