import path from "node:path";
import { workspacePathIssue } from "@kobe/protocol";

/**
 * Where a message's uploads land in the sandbox (KOBE-144): `uploads/<thread>/<name>`. Names are
 * unique per thread: a file whose name is taken by an earlier attachment gets `-2`, `-3`, ...
 * before its extension. Assigned in attachment order (run creation, then upload time, then id),
 * which only ever grows, so a file's path never changes once it has one (a restarted run is sent
 * the same paths). A name the workspace cannot hold (bidirectional controls, over-long UTF-8)
 * falls back to `file-<id prefix>`.
 */
const MAX_SUFFIX = 1000;

export interface NamedFile {
  readonly id: string;
  readonly name: string;
}

export function attachmentPaths(
  threadId: string,
  files: readonly NamedFile[],
): ReadonlyMap<string, string> {
  const used = new Set<string>();
  const paths = new Map<string, string>();
  for (const file of files) {
    const candidate = (name: string) => `uploads/${threadId}/${name}`;
    let base = file.name;
    if (workspacePathIssue(candidate(base)) !== undefined) base = `file-${file.id.slice(0, 8)}`;
    const ext = path.posix.extname(base);
    const stem = ext === "" ? base : base.slice(0, -ext.length);
    let chosen = candidate(base);
    for (let n = 2; used.has(chosen) || workspacePathIssue(chosen) !== undefined; n += 1) {
      if (n > MAX_SUFFIX) throw new Error("attachmentPaths: no free name");
      chosen = candidate(`${stem}-${n}${ext}`);
    }
    used.add(chosen);
    paths.set(file.id, chosen);
  }
  return paths;
}
