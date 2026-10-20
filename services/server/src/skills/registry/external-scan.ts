import { sql, type KobeDb } from "@kobe/db";
import type { IsolationGate } from "../../isolation/gate.js";
import { logger } from "../../logger.js";
import type { BlobStore } from "../../retention/blobs.js";
import type { SandboxSettings } from "../../sandbox/config.js";
import { LABEL_SKILL_SCAN } from "../../sandbox/constants.js";
import type { KubeClient, ObjectRef } from "../../sandbox/kube.js";
import {
  skillScanNetworkPolicyManifest,
  teamNamespaceName,
  type KubeObject,
  type TeamRef,
} from "../../sandbox/manifests.js";
import type { SandboxProvider } from "../../sandbox/provider.js";
import { jobOutcome } from "../../agents/eval/service.js";
import {
  SCAN_CONTAINER,
  SCAN_MAX_PACKAGE_BYTES,
  packageParts,
  scanConfigMapManifest,
  scanJobManifest,
  scanJobName,
} from "./external-scan-job.js";
import { parseScanLog, raisedVerdict, type ExternalScan } from "./external-scan-result.js";
import { readPackage } from "./review-diff.js";
import { readRegistrySettings } from "./settings.js";

/**
 * The optional external skill scanner (KOBE-341, SK32): when a Site admin turned it on, every
 * Registry submission is scanned by Cisco skill-scanner as a Job in the Registry team's namespace
 * (SK21: site-side work runs there). The Job gets the package and nothing else: no network, no
 * secrets, no service account token (`external-scan-job.ts`). Its result goes into the version's
 * scan document (`scan.external`) and may raise Pass to Caution, never to Block; while it runs,
 * Approve waits (`external_scan_running`). Every failure is recorded (`failed`), never fatal to
 * the submission. A sweep finishes scans whose driver died with its server.
 */
const LOG_LIMIT_BYTES = 1024 * 1024;
const POLL_MS = 3_000;
/** The driver gives up this long after the Job's own deadline (image pull and scheduling lag). */
const DRIVER_SLACK_SECONDS = 120;
const OPEN_STATES = ["submitted", "in_review"];
/** Scan Jobs running at once across the Site (review L9); more wait queued. */
export const MAX_CONCURRENT_SCANS = 2;

export interface ExternalScanOptions {
  readonly db: KobeDb;
  readonly blobs: BlobStore;
  readonly kube: KubeClient;
  readonly provider: Pick<SandboxProvider, "ensureTeam">;
  readonly isolation: Pick<IsolationGate, "require">;
  readonly settings: SandboxSettings;
  readonly pollMs?: number;
  readonly now?: () => Date;
  readonly sleep?: (ms: number) => Promise<void>;
}

const ref = (kind: string, name: string, namespace: string, apiVersion = "v1"): ObjectRef => ({
  apiVersion,
  kind,
  name,
  namespace,
});

type VersionRow = {
  id: string;
  state: string;
  verdict: string;
  package_hash: string;
  package_storage_key: string | null;
  runtime_hash: string;
  runtime_storage_key: string | null;
  runtime_size_bytes: number | null;
  external: string | null;
};

export class ExternalScanRunner {
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly pollMs: number;

  constructor(private readonly options: ExternalScanOptions) {
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.pollMs = options.pollMs ?? POLL_MS;
  }

  /** Starts the scan of a new submission in the background; never throws. */
  start(versionId: string): void {
    void this.run(versionId).catch((err: unknown) =>
      logger.error({ err, versionId }, "external skill scan failed"),
    );
  }

  /**
   * Scans one submission whose scan is due (`queued`, written with the submission when the Site
   * has the scanner on). At most {@link MAX_CONCURRENT_SCANS} run at once across the Site (review
   * L9): over the cap the scan stays queued and the sweep starts it later.
   */
  async run(versionId: string): Promise<ExternalScan | null> {
    const { db } = this.options;
    const v = await this.version(versionId);
    if (!v || !OPEN_STATES.includes(v.state) || v.external !== "queued") return null;
    const site = await readRegistrySettings(db);
    const scan = this.options.settings.skillScan;
    const at = () => this.now().toISOString();
    if (!scan)
      return this.record(v, { status: "unavailable", reason: "no_image", finishedAt: at() });
    if (!site.registryTeam)
      return this.record(v, { status: "failed", reason: "registry_not_ready", finishedAt: at() });
    const zip = await readPackage(this.options.blobs, {
      packageHash: v.package_hash,
      packageStorageKey: v.package_storage_key,
      runtimeHash: v.runtime_hash,
      runtimeStorageKey: v.runtime_storage_key,
      runtimeSizeBytes: v.runtime_size_bytes,
    });
    if (!zip) return this.record(v, { status: "failed", reason: "no_package", finishedAt: at() });
    if (zip.length > SCAN_MAX_PACKAGE_BYTES)
      return this.record(v, { status: "skipped", reason: "too_large", finishedAt: at() });
    const startedAt = at();
    if (!(await this.claim(v.id, startedAt))) return null;
    const team: TeamRef = { id: site.registryTeam.id, slug: site.registryTeam.slug };
    let namespace: string | null = null;
    try {
      const verified = await this.options.isolation.require();
      namespace = await this.options.provider.ensureTeam(team, verified);
      await this.options.kube.apply(skillScanNetworkPolicyManifest(namespace));
      const parts = packageParts(zip);
      // The Job first, then its parts owned by it (review L5): nothing outlives the Job.
      const job = await this.options.kube.create(
        scanJobManifest({
          namespace,
          teamId: team.id,
          versionId: v.id,
          isolation: verified,
          sandbox: this.options.settings,
          scan,
          parts: parts.length,
        }),
      );
      const uid = job.metadata.uid;
      if (!uid) throw new Error("the scan Job has no uid");
      for (const [part, bytes] of parts.entries())
        await this.options.kube.apply(
          scanConfigMapManifest({
            namespace,
            teamId: team.id,
            versionId: v.id,
            part,
            bytes,
            owner: { name: scanJobName(v.id), uid },
          }),
        );
      const outcome = await this.waitForJob(namespace, v.id, scan.deadlineSeconds);
      return await this.conclude(v.id, namespace, outcome, startedAt);
    } catch (err) {
      logger.error({ err, versionId }, "external skill scan could not run");
      if (namespace)
        await this.options.kube
          .delete(ref("Job", scanJobName(v.id), namespace, "batch/v1"))
          .catch(() => undefined);
      const failed: ExternalScan = { status: "failed", reason: "job_error", finishedAt: at() };
      return this.record(v, failed);
    }
  }

  /** Marks the scan running if fewer than the cap run now (one claimer at a time). */
  private async claim(versionId: string, startedAt: string): Promise<boolean> {
    return this.options.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended('kobe.skills.external-scan', 0))`,
      );
      const running = await tx.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM registry_versions
         WHERE scan #>> '{external,status}' = 'running'`);
      if (Number(running.rows[0]?.n ?? 0) >= MAX_CONCURRENT_SCANS) return false;
      const claimed = await tx.execute(sql`
        UPDATE registry_versions
           SET scan = jsonb_set(scan, '{external}', ${JSON.stringify({
             status: "running",
             startedAt,
             job: scanJobName(versionId),
           })}::jsonb)
         WHERE id = ${versionId} AND scan #>> '{external,status}' = 'queued'
        RETURNING 1`);
      return claimed.rows.length > 0;
    });
  }

  /** Finishes scans nobody is driving any more (the server restarted mid-scan). */
  async sweep(): Promise<number> {
    // Due scans (a lost start, or over the cap): started now, oldest first (review M1, L9).
    const due = await this.options.db.execute<{ id: string }>(sql`
      SELECT id FROM registry_versions
       WHERE scan #>> '{external,status}' = 'queued'
         AND (scan #>> '{external,queuedAt}')::timestamptz < now() - interval '1 minute'
       ORDER BY scan #>> '{external,queuedAt}' LIMIT ${MAX_CONCURRENT_SCANS}`);
    for (const row of due.rows) this.start(row.id);
    const scan = this.options.settings.skillScan;
    if (!scan) return due.rows.length;
    const before = new Date(
      this.now().getTime() - (scan.deadlineSeconds + 2 * DRIVER_SLACK_SECONDS) * 1000,
    ).toISOString();
    const stale = await this.options.db.execute<{ id: string; started: string }>(sql`
      SELECT id, scan #>> '{external,startedAt}' AS started FROM registry_versions
       WHERE scan #>> '{external,status}' = 'running'
         AND (scan #>> '{external,startedAt}')::timestamptz < ${before}::timestamptz`);
    const site = await readRegistrySettings(this.options.db);
    let finished = 0;
    for (const row of stale.rows) {
      const namespace = site.registryTeam
        ? teamNamespaceName({ id: site.registryTeam.id, slug: site.registryTeam.slug })
        : null;
      const job = namespace
        ? await this.options.kube.get(ref("Job", scanJobName(row.id), namespace, "batch/v1"))
        : undefined;
      const outcome = job ? jobOutcome(job) : undefined;
      if (namespace && outcome) await this.conclude(row.id, namespace, outcome, row.started);
      else {
        const v = await this.version(row.id);
        if (v)
          await this.record(v, {
            status: "failed",
            reason: "interrupted",
            finishedAt: this.now().toISOString(),
          });
      }
      finished++;
    }
    return finished;
  }

  private async version(id: string): Promise<VersionRow | undefined> {
    const r = await this.options.db.execute<VersionRow>(sql`
      SELECT id, state::text AS state, verdict::text AS verdict, package_hash,
        package_storage_key, runtime_hash, runtime_storage_key, runtime_size_bytes,
        scan #>> '{external,status}' AS external
        FROM registry_versions WHERE id = ${id} AND publisher = 'maintainer'`);
    return r.rows[0];
  }

  private async waitForJob(namespace: string, versionId: string, deadlineSeconds: number) {
    const deadline = this.now().getTime() + (deadlineSeconds + DRIVER_SLACK_SECONDS) * 1000;
    const jobRef = ref("Job", scanJobName(versionId), namespace, "batch/v1");
    for (;;) {
      const job: KubeObject = (await this.options.kube.get(jobRef)) ?? EMPTY;
      const outcome = jobOutcome(job);
      if (outcome) return outcome;
      if (this.now().getTime() >= deadline) {
        await this.options.kube.delete(jobRef);
        return { kind: "failed" as const, reason: "timed out" };
      }
      await this.sleep(this.pollMs);
    }
  }

  private async conclude(
    versionId: string,
    namespace: string,
    outcome: ReturnType<typeof jobOutcome>,
    startedAt: string | null,
  ): Promise<ExternalScan | null> {
    const finishedAt = this.now().toISOString();
    const pods = await this.options.kube.list(
      "v1",
      "Pod",
      namespace,
      `${LABEL_SKILL_SCAN}=${versionId}`,
    );
    const pod = pods[0];
    const log = pod
      ? ((await this.options.kube.logs(ref("Pod", pod.metadata.name, namespace), {
          container: SCAN_CONTAINER,
          limitBytes: LOG_LIMIT_BYTES,
        })) ?? "")
      : "";
    let result = parseScanLog(log, { startedAt, finishedAt });
    if (result.status === "failed" && outcome?.kind === "failed" && result.reason === "no_result")
      result = { status: "failed", reason: outcome.reason.slice(0, 40), finishedAt };
    const v = await this.version(versionId);
    return v ? this.record(v, result) : null;
  }

  /**
   * Stores the result on the version (locked): the verdict rises only while the version is still
   * under review; a decided version keeps its verdict and gets the findings for the record.
   */
  private async record(v: VersionRow, result: ExternalScan): Promise<ExternalScan> {
    await this.options.db.transaction(async (tx) => {
      const cur = await tx.execute<{ state: string; verdict: string }>(sql`
        SELECT state::text AS state, verdict::text AS verdict FROM registry_versions
         WHERE id = ${v.id} FOR UPDATE`);
      const row = cur.rows[0];
      if (!row) return;
      const verdict = OPEN_STATES.includes(row.state)
        ? raisedVerdict(row.verdict, result)
        : row.verdict;
      await tx.execute(sql`
        UPDATE registry_versions
           SET scan = jsonb_set(scan, '{external}', ${JSON.stringify(result)}::jsonb),
               verdict = ${verdict}::scan_verdict, updated_at = now()
         WHERE id = ${v.id}`);
    });
    return result;
  }
}

const EMPTY: KubeObject = { apiVersion: "", kind: "", metadata: { name: "" } };

/**
 * A submission made while the scanner is on but this server has no runner (no sandbox provider
 * or object storage, review M1): recorded `unavailable`, which the review treats as incomplete.
 */
export async function markNoRunner(db: KobeDb, versionId: string): Promise<void> {
  await db.execute(sql`
    UPDATE registry_versions
       SET scan = jsonb_set(scan, '{external}', ${JSON.stringify({
         status: "unavailable",
         reason: "no_runner",
         finishedAt: new Date().toISOString(),
       })}::jsonb),
           verdict = CASE WHEN verdict = 'pass' THEN 'caution'::scan_verdict ELSE verdict END
     WHERE id = ${versionId} AND scan #>> '{external,status}' = 'queued'`);
}
