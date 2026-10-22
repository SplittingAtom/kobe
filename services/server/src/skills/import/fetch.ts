import { createHash } from "node:crypto";
import * as fs from "node:fs";
import path_ from "node:path";
import git, { Errors, type HttpClient } from "isomorphic-git";

/**
 * Fetching an import (KOBE-344, SK30), server-side, once, through the caller's HTTP client (the
 * egress proxy in a cluster). Git: the exact commit by its SHA (a ref name is never taken), alone
 * where the host serves that, else among every branch and tag (a commit none reaches is
 * refused), and the files of its tree, or of one folder in it. Zip: one GET, no redirects, its SHA-256 checked
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
  | "hash_mismatch"
  | "timed_out";

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
  // First the commit alone (depth 1, by its SHA): what GitHub and other hosts that allow a
  // reachable SHA in a want serve, and the smallest fetch. Where a host refuses that, every
  // branch and tag, then the commit among them (a commit none reaches is refused).
  const byCommit = path_.join(dir, "commit");
  const everything = path_.join(dir, "all");
  let repo = byCommit;
  try {
    await initRepo(byCommit, url);
    await git.fetch({
      fs,
      http,
      dir: byCommit,
      remote: "origin",
      ref: commit,
      remoteRef: commit,
      singleBranch: true,
      depth: 1,
      tags: false,
    });
    await git.readCommit({ fs, dir: byCommit, oid: commit });
  } catch (err) {
    if (err instanceof ImportError) throw err;
    if (tookTooLong(err)) throw timedOut();
    repo = everything;
    try {
      await initRepo(everything, url);
      await git.fetch({
        fs,
        http,
        dir: everything,
        remote: "origin",
        singleBranch: false,
        tags: true,
      });
    } catch (err2) {
      if (err2 instanceof ImportError) throw err2;
      if (tookTooLong(err2)) throw timedOut();
      throw new ImportError(
        "fetch_failed",
        `The repository could not be fetched (${message(err2)}).`,
      );
    }
  }
  let tree: string;
  try {
    tree = (await git.readCommit({ fs, dir: repo, oid: commit })).commit.tree;
  } catch {
    throw new ImportError(
      "commit_not_found",
      "That commit is not on any branch or tag of the repository.",
    );
  }
  for (const segment of path ? path.split("/") : []) {
    const entry = (await git.readTree({ fs, dir: repo, oid: tree })).tree.find(
      (e) => e.path === segment,
    );
    if (entry?.type !== "tree")
      throw new ImportError("path_not_found", `The commit has no folder ${path}.`);
    tree = entry.oid;
  }
  const files = new Map<string, Uint8Array>();
  let bytes = 0;
  const walk = async (oid: string, prefix: string): Promise<void> => {
    for (const e of (await git.readTree({ fs, dir: repo, oid })).tree) {
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
      const { blob } = await git.readBlob({ fs, dir: repo, oid: e.oid });
      bytes += blob.length;
      if (bytes > caps.maxBytes)
        throw new ImportError("too_large", `The skill is larger than ${caps.maxBytes} bytes.`);
      files.set(p, blob);
    }
  };
  await walk(tree, "");
  return files;
}

const tookTooLong = (err: unknown) => err instanceof Error && /took too long/.test(err.message);
const timedOut = () =>
  new ImportError(
    "timed_out",
    "The import took too long; try again, or import a smaller repository.",
  );

async function initRepo(dir: string, url: string): Promise<void> {
  await fs.promises.mkdir(dir, { recursive: true });
  await git.init({ fs, dir });
  await git.addRemote({ fs, dir, remote: "origin", url });
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
    if (tookTooLong(err)) throw timedOut();
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
  try {
    for await (const c of res.body ?? []) {
      size += c.length;
      if (size > maxBytes)
        throw new ImportError("too_large", `The zip is larger than ${maxBytes} bytes.`);
      chunks.push(c);
    }
  } catch (err) {
    if (err instanceof ImportError) throw err;
    if (tookTooLong(err) || /aborted/.test(String(err))) throw timedOut();
    throw err;
  }
  const bytes = new Uint8Array(Buffer.concat(chunks));
  if (sha256(bytes) !== expectedSha256)
    throw new ImportError(
      "hash_mismatch",
      "The zip's SHA-256 is not the one given: the content behind the URL differs.",
    );
  return bytes;
}
