import * as fs from "node:fs";
import git, { Errors, type HttpClient, type TreeEntry } from "isomorphic-git";
import { mirrorTagName, type PackageFiles } from "@kobe/protocol";
import { CATALOG_JSON_PATH, readCatalogJson, writeCatalogJson } from "./catalog-json.js";

/**
 * The git side of the catalog mirror (KOBE-343, SK29), independent of the database. A session
 * reads the remote's refs once, fetches the branch's recent history, then appends one commit per
 * version on top of the remote's head and pushes it with an annotated tag `<name>/v<semver>`.
 *
 * Append-only by construction: every commit's parent is the remote head (fetched, or the commit
 * this session just pushed), pushes are never forced (isomorphic-git refuses a non-fast-forward
 * and an existing tag), and an existing tag is never moved: when the remote already has the tag
 * with exactly this version's tree it counts as pushed, otherwise it is a conflict for a person to
 * resolve. A commit already on the branch for this version (a crash between the branch and the
 * tag push) is tagged rather than committed twice.
 */

/** Commits read back for the "already committed" check. */
export const MIRROR_HISTORY_DEPTH = 100;

export interface MirrorAuthor {
  readonly name: string;
  readonly email: string;
}

export interface MirrorVersionInput {
  readonly registryVersionId: string;
  readonly name: string;
  readonly semver: string;
  readonly runtimeHash: string;
  readonly packageHash: string;
  /** The package files, `provenance.json` included, as they go under `skills/<name>/`. */
  readonly files: PackageFiles;
}

export interface MirroredVersion {
  readonly commit: string;
  readonly tag: string;
  readonly tree: string;
  /** The remote already had this tag with this tree; nothing was pushed. */
  readonly existing: boolean;
}

/** A problem with one version (the next one may still go); anything else stops the session. */
export class MirrorVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MirrorVersionError";
  }
}

export interface MirrorRemote {
  readonly url: string;
  readonly branch: string;
  readonly http: HttpClient;
  readonly author: MirrorAuthor;
  readonly now?: () => Date;
}

interface RemoteRef {
  readonly oid: string;
  readonly peeled?: string;
}

const BLOB = "100644";
const GITATTRIBUTES = new TextEncoder().encode("* -text\n");
const TREE = "040000";

/** Git's tree order: byte order of names, a directory compared as `name/`. */
function gitOrder(a: TreeEntry, b: TreeEntry): number {
  const ka = Buffer.from(a.type === "tree" ? `${a.path}/` : a.path);
  const kb = Buffer.from(b.type === "tree" ? `${b.path}/` : b.path);
  return Buffer.compare(ka, kb);
}

export class MirrorSession {
  private head: string | null = null;
  private tags = new Map<string, RemoteRef>();

  private constructor(
    private readonly remote: MirrorRemote,
    private readonly dir: string,
  ) {}

  /** Inits the work repository in `dir` (empty, owned by the caller) and reads the remote. */
  static async open(remote: MirrorRemote, dir: string): Promise<MirrorSession> {
    const s = new MirrorSession(remote, dir);
    await git.init({ fs, dir, defaultBranch: remote.branch });
    await git.addRemote({ fs, dir, remote: "origin", url: remote.url });
    const info = await git.getRemoteInfo2({
      http: remote.http,
      url: remote.url,
      protocolVersion: 1,
    });
    const refs = (info.refs ?? []) as { ref: string; oid: string; peeled?: string }[];
    for (const r of refs) {
      if (r.ref.startsWith("refs/tags/"))
        s.tags.set(r.ref, { oid: r.oid, ...(r.peeled ? { peeled: r.peeled } : {}) });
    }
    const branch = refs.find((r) => r.ref === `refs/heads/${remote.branch}`);
    if (branch) {
      const fetched = await git.fetch({
        fs,
        http: remote.http,
        dir,
        remote: "origin",
        ref: remote.branch,
        singleBranch: true,
        depth: MIRROR_HISTORY_DEPTH,
        tags: false,
      });
      s.head = fetched.fetchHead ?? branch.oid;
      await s.setRef(`refs/heads/${remote.branch}`, s.head);
    }
    return s;
  }

  get headCommit(): string | null {
    return this.head;
  }

  /** Mirrors one version: its commit (new or found) and its tag, both on the remote. */
  async mirror(v: MirrorVersionInput): Promise<MirroredVersion> {
    const tagName = mirrorTagName(v.name, v.semver);
    const tagRef = `refs/tags/${tagName}`;
    const tree = await this.writeFiles(v.files);
    const existingTag = this.tags.get(tagRef);
    if (existingTag) {
      const commit = existingTag.peeled ?? existingTag.oid;
      if ((await this.skillTreeAt(commit, v.name)) === tree)
        return { commit, tag: tagName, tree, existing: true };
      throw new MirrorVersionError(
        `the remote already has tag ${tagName} with other content; Kobe never moves a tag`,
      );
    }
    const commit = (await this.findCommitted(v, tree)) ?? (await this.commit(v, tree, tagName));
    await this.pushTag(v, tagName, commit);
    return { commit, tag: tagName, tree, existing: false };
  }

  private async setRef(ref: string, value: string): Promise<void> {
    await git.writeRef({ fs, dir: this.dir, ref, value, force: true });
  }

  /** Writes the package as a tree (blobs 100644) and returns its oid. */
  private async writeFiles(files: PackageFiles): Promise<string> {
    const root = new Map<string, unknown>();
    for (const [path, bytes] of files) {
      const parts = path.split("/");
      let node = root;
      for (const dirName of parts.slice(0, -1)) {
        let next = node.get(dirName);
        if (!(next instanceof Map)) {
          next = new Map<string, unknown>();
          node.set(dirName, next);
        }
        node = next as Map<string, unknown>;
      }
      node.set(parts[parts.length - 1] as string, bytes);
    }
    const write = async (node: Map<string, unknown>): Promise<string> => {
      const entries: TreeEntry[] = [];
      for (const [name, child] of node) {
        if (child instanceof Map)
          entries.push({ mode: TREE, path: name, type: "tree", oid: await write(child) });
        else
          entries.push({
            mode: BLOB,
            path: name,
            type: "blob",
            oid: await git.writeBlob({ fs, dir: this.dir, blob: child as Uint8Array }),
          });
      }
      return git.writeTree({ fs, dir: this.dir, tree: entries.sort(gitOrder) });
    };
    return write(root);
  }

  /** The oid of `skills/<name>` in `commit`, or null when absent or unreadable. */
  private async skillTreeAt(commit: string, name: string): Promise<string | null> {
    try {
      const { oid } = await git.readTree({
        fs,
        dir: this.dir,
        oid: commit,
        filepath: `skills/${name}`,
      });
      return oid;
    } catch {
      return null;
    }
  }

  /** A commit on the fetched branch for this version with exactly this tree, if any. */
  private async findCommitted(v: MirrorVersionInput, tree: string): Promise<string | null> {
    if (!this.head) return null;
    const trailer = `Kobe-Registry-Version: ${v.registryVersionId}`;
    let log: Awaited<ReturnType<typeof git.log>>;
    try {
      log = await git.log({ fs, dir: this.dir, ref: this.head, depth: MIRROR_HISTORY_DEPTH });
    } catch (err) {
      // A shallow history ends in commits whose parents are missing.
      if (err instanceof Errors.NotFoundError) return null;
      throw err;
    }
    for (const entry of log) {
      if (!entry.commit.message.split("\n").includes(trailer)) continue;
      if ((await this.skillTreeAt(entry.oid, v.name)) === tree) return entry.oid;
    }
    return null;
  }

  private signature() {
    const now = this.remote.now?.() ?? new Date();
    return {
      name: this.remote.author.name,
      email: this.remote.author.email,
      timestamp: Math.floor(now.getTime() / 1000),
      timezoneOffset: 0,
    };
  }

  /** Sets `entry` at `path` under `base` (a tree oid or none), writing every tree on the way. */
  private async setPath(base: string | null, path: string[], entry: TreeEntry): Promise<string> {
    const entries = base ? (await git.readTree({ fs, dir: this.dir, oid: base })).tree : [];
    const [first, ...rest] = path as [string, ...string[]];
    const existing = entries.find((e) => e.path === first);
    const replacement: TreeEntry =
      rest.length === 0
        ? { ...entry, path: first }
        : {
            mode: TREE,
            path: first,
            type: "tree",
            oid: await this.setPath(existing?.type === "tree" ? existing.oid : null, rest, entry),
          };
    const next = entries.filter((e) => e.path !== first).concat(replacement);
    return git.writeTree({ fs, dir: this.dir, tree: next.sort(gitOrder) });
  }

  private async readCatalog(rootTree: string | null): Promise<Uint8Array | null> {
    if (!rootTree) return null;
    const entry = (await git.readTree({ fs, dir: this.dir, oid: rootTree })).tree.find(
      (e) => e.path === CATALOG_JSON_PATH && e.type === "blob",
    );
    if (!entry) return null;
    return (await git.readBlob({ fs, dir: this.dir, oid: entry.oid })).blob;
  }

  private async commit(v: MirrorVersionInput, tree: string, tagName: string): Promise<string> {
    const baseTree = this.head
      ? (await git.readCommit({ fs, dir: this.dir, oid: this.head })).commit.tree
      : null;
    const withSkill = await this.setPath(baseTree, ["skills", v.name], {
      mode: TREE,
      path: v.name,
      type: "tree",
      oid: tree,
    });
    // Bytes are the package's: no line-ending conversion on checkout (docs/skill-package.md).
    const withAttributes = await this.setPath(withSkill, ["skills", ".gitattributes"], {
      mode: BLOB,
      path: ".gitattributes",
      type: "blob",
      oid: await git.writeBlob({ fs, dir: this.dir, blob: GITATTRIBUTES }),
    });
    const catalog = writeCatalogJson(readCatalogJson(await this.readCatalog(baseTree)), {
      name: v.name,
      semver: v.semver,
      tag: tagName,
      runtimeHash: v.runtimeHash,
      packageHash: v.packageHash,
    });
    const root = await this.setPath(withAttributes, [CATALOG_JSON_PATH], {
      mode: BLOB,
      path: CATALOG_JSON_PATH,
      type: "blob",
      oid: await git.writeBlob({ fs, dir: this.dir, blob: catalog }),
    });
    const sig = this.signature();
    const commit = await git.writeCommit({
      fs,
      dir: this.dir,
      commit: {
        message: [
          `${v.name} v${v.semver}`,
          "",
          "An approved Kobe catalog version, mirrored one way: Kobe never reads this repository back.",
          "",
          `Kobe-Registry-Version: ${v.registryVersionId}`,
          `Kobe-Runtime-Hash: ${v.runtimeHash}`,
          `Kobe-Package-Hash: ${v.packageHash}`,
          "",
        ].join("\n"),
        tree: root,
        parent: this.head ? [this.head] : [],
        author: sig,
        committer: sig,
      },
    });
    const ref = `refs/heads/${this.remote.branch}`;
    await this.setRef(ref, commit);
    await this.push(ref);
    this.head = commit;
    return commit;
  }

  private async pushTag(v: MirrorVersionInput, tagName: string, commit: string): Promise<void> {
    const tagOid = await git.writeTag({
      fs,
      dir: this.dir,
      tag: {
        object: commit,
        type: "commit",
        tag: tagName,
        tagger: this.signature(),
        message: [
          `${v.name} ${v.semver}`,
          "",
          `Kobe-Registry-Version: ${v.registryVersionId}`,
          `Kobe-Runtime-Hash: ${v.runtimeHash}`,
          `Kobe-Package-Hash: ${v.packageHash}`,
          "",
        ].join("\n"),
      },
    });
    const ref = `refs/tags/${tagName}`;
    await this.setRef(ref, tagOid);
    await this.push(ref);
    this.tags.set(ref, { oid: tagOid, peeled: commit });
  }

  /** Pushes one ref, never forced; a refusal by the remote is an error. */
  private async push(ref: string): Promise<void> {
    const result = await git.push({
      fs,
      http: this.remote.http,
      dir: this.dir,
      url: this.remote.url,
      ref,
      remoteRef: ref,
      force: false,
    });
    const status = result.refs?.[ref];
    if (!result.ok || (status && !status.ok))
      throw new Error(`the remote refused ${ref}: ${status?.error ?? result.error ?? "unknown"}`);
  }
}
