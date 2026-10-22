import { createHash } from "node:crypto";
import * as fs from "node:fs";
import git, { Errors, type HttpClient } from "isomorphic-git";

/**
 * Fetching an import (KOBE-344, SK30), server-side, once, through the caller's HTTP client (the
 * egress proxy in a cluster). Git: every branch and tag of the repository, then the exact commit
 * by its SHA (a ref name is never taken; a commit no branch or tag reaches is refused), and the
 * files of its tree, or of one folder in it. Zip: one GET, no redirects, its SHA-256 checked
 * against the request. Both stop at the import caps; isomorphic-git runs no hooks, checks out
 * nothing and follows no submodule; symlinks and submodules are refused.
 */
export interface ImportCaps {
  readonly maxFiles: number;
  /** All files together. */
  readonly maxBytes: number;
}

export type ImportErrorCode =
  | "fetch_failed"
  | "commit_not_found"
  | "path_not_found"
  | "unsupported_entry"
  | "too_large"
  | "hash_mismatch";

/** An import refused; `message` is safe to show (no credentials ever exist on this path). */
export class ImportError extends Error {
  constructor(
    readonly code: ImportErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ImportError";
  }
}

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

export async function fetchGitFiles(
  http: HttpClient,
  url: string,
  commit: string,
  path: string | undefined,
  dir: string,
  caps: ImportCaps,
): Promise<Map<string, Uint8Array>> {
  try {
    await git.init({ fs, dir });
    await git.addRemote({ fs, dir, remote: "origin", url });
    await git.fetch({ fs, http, dir, remote: "origin", singleBranch: false, tags: true });
  } catch (err) {
    if (err instanceof ImportError) throw err;
    throw new ImportError("fetch_failed", `The repository could not be fetched (${message(err)}).`);
  }
  let tree: string;
  try {
    tree = (await git.readCommit({ fs, dir, oid: commit })).commit.tree;
  } catch {
    throw new ImportError(
      "commit_not_found",
      "That commit is not on any branch or tag of the repository.",
    );
  }
  for (const segment of path ? path.split("/") : []) {
    const entry = (await git.readTree({ fs, dir, oid: tree })).tree.find((e) => e.path === segment);
    if (entry?.type !== "tree")
      throw new ImportError("path_not_found", `The commit has no folder ${path}.`);
    tree = entry.oid;
  }
  const files = new Map<string, Uint8Array>();
  let bytes = 0;
  const walk = async (oid: string, prefix: string): Promise<void> => {
    for (const e of (await git.readTree({ fs, dir, oid })).tree) {
      const p = `${prefix}${e.path}`;
      if (e.type === "tree") {
        await walk(e.oid, `${p}/`);
        continue;
      }
      if (e.type !== "blob" || (e.mode !== "100644" && e.mode !== "100755"))
        throw new ImportError(
          "unsupported_entry",
          `${p} is a ${e.mode === "120000" ? "symlink" : "submodule"}; skills hold files only.`,
        );
      if (files.size + 1 > caps.maxFiles)
        throw new ImportError("too_large", `The skill has more than ${caps.maxFiles} files.`);
      const { blob } = await git.readBlob({ fs, dir, oid: e.oid });
      bytes += blob.length;
      if (bytes > caps.maxBytes)
        throw new ImportError("too_large", `The skill is larger than ${caps.maxBytes} bytes.`);
      files.set(p, blob);
    }
  };
  await walk(tree, "");
  return files;
}

function message(err: unknown): string {
  if (err instanceof Errors.HttpError) return `HTTP ${err.data.statusCode}`;
  return err instanceof Error ? err.message : String(err);
}

export async function fetchZip(
  http: HttpClient,
  url: string,
  expectedSha256: string,
  maxBytes: number,
): Promise<Uint8Array> {
  let res: Awaited<ReturnType<HttpClient["request"]>>;
  try {
    res = await http.request({ url, method: "GET" });
  } catch (err) {
    throw new ImportError("fetch_failed", `The zip could not be fetched (${message(err)}).`);
  }
  if (res.statusCode !== 200)
    throw new ImportError(
      "fetch_failed",
      res.statusCode >= 300 && res.statusCode < 400
        ? "The zip URL redirects; give the final URL (redirects are not followed)."
        : `The zip could not be fetched (HTTP ${res.statusCode}).`,
    );
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const c of res.body ?? []) {
    size += c.length;
    if (size > maxBytes)
      throw new ImportError("too_large", `The zip is larger than ${maxBytes} bytes.`);
    chunks.push(c);
  }
  const bytes = new Uint8Array(Buffer.concat(chunks));
  if (sha256(bytes) !== expectedSha256)
    throw new ImportError(
      "hash_mismatch",
      "The zip's SHA-256 is not the one given: the content behind the URL differs.",
    );
  return bytes;
}
