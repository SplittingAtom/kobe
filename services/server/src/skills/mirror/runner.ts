import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { unzipSync } from "fflate";
import type { HttpClient } from "isomorphic-git";
import type pg from "pg";
import { PROVENANCE_PATH, canonicalJsonBytes, provenanceSchema } from "@kobe/protocol";
import { skillPackageHashes } from "@kobe/protocol/node";
import { signSiteEgressToken } from "@kobe/session-token";
import type { KobeDb } from "@kobe/db";
import { logger } from "../../logger.js";
import type { BlobStore } from "../../retention/blobs.js";
import { createPgReconcileLock } from "../../sandbox/reconcile-lock.js";
import { readPackage } from "../registry/review-diff.js";
import { readRegistrySettings } from "../registry/settings.js";
import { MirrorSession, MirrorVersionError, type MirrorAuthor } from "./git-mirror.js";
import { mirrorHttpClient } from "./http-client.js";
import {
  pendingMirrorVersions,
  recordMirrorFailure,
  recordMirrorSuccess,
  withdrawBlocked,
  type PendingVersion,
} from "./mirror-store.js";

/**
 * The catalog's git mirror job (KOBE-343, SK29): off unless a Site admin turns it on with an
 * https remote. Kicked after every approval and settings change, and swept every few minutes for
 * retries; one server replica at a time (advisory lock). Each run pushes the pending published
 * versions in approval order, through the egress proxy with a site egress token, with the token
 * from the Kubernetes Secret as Basic credentials to the remote only. Failures back off per
 * version; a remote or transport failure stops the run, a version's own problem (bytes missing,
 * a conflicting tag) only skips that version. Nothing here ever reads the mirror back as a source.
 */
export const SKILL_MIRROR_LOCK = "kobe.skill-mirror";
export const SKILL_MIRROR_SWEEP_MS = 5 * 60_000;
export const SKILL_MIRROR_BATCH = 25;

export interface SkillMirrorDeps {
  readonly db: KobeDb;
  readonly pool: Pick<pg.Pool, "connect">;
  readonly blobs: BlobStore;
  readonly credentials: { readonly username: string; readonly token: string } | null;
  /** The egress proxy and its key (site egress tokens); null: this server can't push. */
  readonly egress: { readonly proxyUrl: string; readonly key: string } | null;
  readonly author: MirrorAuthor;
  readonly now?: () => Date;
  /** Tests: the HTTP client for a remote (no proxy). */
  readonly transport?: (remote: string) => HttpClient;
}

export type MirrorMissing = "token" | "egress_proxy";

export type SweepResult =
  | { readonly ran: false; readonly reason: "off" | "not_ready" | "locked" }
  | { readonly ran: true; readonly pushed: number; readonly failed: number };

/** Removes the token (and its Basic encoding) from a message before it is stored or logged. */
export function redact(message: string, token: string | undefined, username?: string): string {
  if (!token) return message;
  let out = message.split(token).join("***");
  if (username) {
    const basic = Buffer.from(`${username}:${token}`).toString("base64");
    out = out.split(basic).join("***");
  }
  return out;
}

export class SkillMirror {
  private running: Promise<SweepResult> | null = null;
  private again = false;

  constructor(private readonly deps: SkillMirrorDeps) {}

  /** What this server lacks to push (shown in the console). */
  missing(): MirrorMissing[] {
    if (this.deps.transport) return [];
    return [
      ...(this.deps.credentials ? [] : (["token"] as const)),
      ...(this.deps.egress ? [] : (["egress_proxy"] as const)),
    ];
  }

  /** Runs a sweep soon; a kick during a run runs one more after it. */
  kick(): void {
    if (this.running) {
      this.again = true;
      return;
    }
    void this.sweep().catch((err: unknown) => logger.warn({ err }, "skill mirror sweep failed"));
  }

  async sweep(): Promise<SweepResult> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = this.sweepLocked();
    try {
      let result = await this.running;
      while (this.again) {
        this.again = false;
        this.running = this.sweepLocked();
        result = await this.running;
      }
      return result;
    } finally {
      this.running = null;
    }
  }

  private async sweepLocked(): Promise<SweepResult> {
    const settings = (await readRegistrySettings(this.deps.db)).mirror;
    if (!settings.enabled || !settings.url) return { ran: false, reason: "off" };
    if (this.missing().length > 0) return { ran: false, reason: "not_ready" };
    const url = settings.url;
    const branch = settings.branch ?? "main";
    const lock = createPgReconcileLock(
      this.deps.pool,
      (err) => logger.warn({ err }, "skill mirror lock connection problem"),
      SKILL_MIRROR_LOCK,
    );
    const r = await lock.runExclusive(() => this.run(url, branch));
    return r.ran ? r.value : { ran: false, reason: "locked" };
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private http(url: string): HttpClient {
    if (this.deps.transport) return this.deps.transport(url);
    const egress = this.deps.egress as NonNullable<SkillMirrorDeps["egress"]>;
    return mirrorHttpClient({
      remote: url,
      credentials: this.deps.credentials,
      proxy: { url: egress.proxyUrl, token: () => signSiteEgressToken("skill-mirror", egress.key) },
    });
  }

  private redact(message: string): string {
    return redact(message, this.deps.credentials?.token, this.deps.credentials?.username);
  }

  private async run(url: string, branch: string): Promise<SweepResult> {
    // Blocklisted versions are withdrawn first: never pushed, dropped from catalog.json.
    const withdrawn = await withdrawBlocked(this.deps.db, url, this.now());
    const pending = await pendingMirrorVersions(this.deps.db, url, this.now(), SKILL_MIRROR_BATCH);
    if (pending.length === 0) return { ran: true, pushed: 0, failed: 0 };
    const dir = await mkdtemp(path.join(tmpdir(), "kobe-skill-mirror-"));
    let pushed = 0;
    let failed = 0;
    try {
      let session: MirrorSession;
      try {
        session = await MirrorSession.open(
          {
            url,
            branch,
            http: this.http(url),
            author: this.deps.author,
            now: () => this.now(),
            withdrawn,
          },
          dir,
        );
      } catch (err) {
        // The remote is unreachable or refuses us: shown on the oldest pending version.
        await this.fail(pending[0] as PendingVersion, url, err);
        return { ran: true, pushed, failed: 1 };
      }
      for (const v of pending) {
        try {
          const files = await this.packageFiles(v);
          const result = await session.mirror({
            registryVersionId: v.id,
            name: v.name,
            semver: v.semver,
            runtimeHash: v.runtimeHash,
            packageHash: v.packageHash,
            files,
          });
          await recordMirrorSuccess(this.deps.db, v, url, result, this.now());
          pushed += 1;
        } catch (err) {
          await this.fail(v, url, err);
          failed += 1;
          if (!(err instanceof MirrorVersionError)) break;
        }
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    return { ran: true, pushed, failed };
  }

  private async fail(v: PendingVersion, url: string, err: unknown): Promise<void> {
    const message = this.redact(err instanceof Error ? err.message : String(err));
    logger.warn(
      { registryVersionId: v.id, name: v.name, semver: v.semver, error: message },
      "skill mirror push failed",
    );
    await recordMirrorFailure(this.deps.db, v, url, message, this.now());
  }

  /**
   * The version's package files plus Kobe's provenance.json, checked against both hashes the
   * version records: what goes under `skills/<name>/` is exactly the reviewed package.
   */
  private async packageFiles(v: PendingVersion): Promise<Map<string, Uint8Array>> {
    let zip: Uint8Array | null;
    try {
      zip = await readPackage(this.deps.blobs, v);
    } catch {
      throw new MirrorVersionError("the version's stored bytes don't match its hash");
    }
    if (!zip) throw new MirrorVersionError("the version's package is not in the object store");
    const files = new Map<string, Uint8Array>(
      Object.entries(unzipSync(zip)).filter(([p]) => !p.endsWith("/") && p !== PROVENANCE_PATH),
    );
    let hashes: { runtimeHash: string; packageHash: string };
    try {
      hashes = skillPackageHashes(files);
    } catch (err) {
      // Names the paths and why (git-reserved names, case collisions, …).
      throw new MirrorVersionError(
        `the version's files are not a valid package: ${(err as Error).message}`,
      );
    }
    if (hashes.runtimeHash !== v.runtimeHash || hashes.packageHash !== v.packageHash)
      throw new MirrorVersionError(
        "the version's files don't hash to its runtime and package hashes",
      );
    const provenance = provenanceSchema.safeParse(v.provenance);
    if (provenance.success) files.set(PROVENANCE_PATH, canonicalJsonBytes(provenance.data));
    return files;
  }
}
