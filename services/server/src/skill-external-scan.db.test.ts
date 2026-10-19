import { randomBytes, randomUUID } from "node:crypto";
import { strToU8, zipSync } from "fflate";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { validateZipBundle } from "./skills/bundle.js";
import { ensureObject } from "./skills/kobe-seed.js";
import { ExternalScanRunner } from "./skills/registry/external-scan.js";
import { SCAN_MARKER } from "./skills/registry/external-scan-result.js";
import { reviewDetail } from "./skills/registry/review-detail.js";
import { sha256Hex } from "./skills/storage.js";
import type { SandboxSettings } from "./sandbox/config.js";
import type { KubeObject } from "./sandbox/manifests.js";
import { createFakeKube, type FakeKube } from "./testing/fake-kube.js";
import { openHarness, type Harness } from "./testing/harness.js";
import { MemoryObjects } from "./testing/memory-objects.js";
import { SETTINGS, gateFor, seedCluster } from "./testing/sandbox-fixtures.js";

/**
 * KOBE-341 (SK32): the optional external scanner. Off by default; on, each submission is scanned
 * by a Job in the Registry team's namespace that holds the package only and reaches nothing; its
 * findings are advisory (Caution at most) and Approve waits for them. The Job controller and the
 * scanner's output line are simulated; everything else is real.
 */
const objects = new MemoryObjects();
const blobs = { objects, prefix: "kobe/" };
let h: Harness;
let kube: FakeKube;
const registryTeam = randomUUID();
const ids = { submitter: "", reviewer: "" };
const SCAN = {
  image: "ghcr.io/splittingatom/kobe-skill-scan:0.1.0",
  deadlineSeconds: 300,
  resources: { requests: { cpu: "250m", memory: "512Mi" }, limits: { cpu: "1", memory: "2Gi" } },
};
const withScan: SandboxSettings = { ...SETTINGS, skillScan: SCAN };
/** What the scan prints, or "hang" (the Job never ends). */
let output: string | "hang" = "";
let seq = 0;

const resultLine = (findings: object[]) =>
  `${SCAN_MARKER}${JSON.stringify({ v: 1, scanner: "cisco-ai-skill-scanner", version: "2.2.1", findings })}\n`;
const critical = {
  ruleId: "YARA_prompt_injection_generic",
  severity: "critical",
  category: "prompt_injection",
  title: "PROMPT INJECTION detected by YARA",
  file: "SKILL.md",
  line: 2,
};

function finishJob(fake: FakeKube, object: KubeObject): void {
  if (object.kind !== "Job" || output === "hang") return;
  const ns = object.metadata.namespace as string;
  const versionId = object.metadata.labels?.["kobe.splittingatom.io/skill-scan"] as string;
  const pod = `${object.metadata.name}-abcde`;
  fake.seed({
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: pod,
      namespace: ns,
      labels: { "kobe.splittingatom.io/skill-scan": versionId },
    },
  });
  fake.podLogs.set(`${ns}/${pod}`, output);
  fake.seed({ ...object, status: { conditions: [{ type: "Complete", status: "True" }] } });
}

const runner = (settings: SandboxSettings = withScan) =>
  new ExternalScanRunner({
    db: h.deps.database.db,
    blobs,
    kube,
    provider: { ensureTeam: async () => "kobe-team-registry" },
    isolation: gateFor(kube),
    settings,
    pollMs: 1,
  });

/** A submitted version with its package stored; `bytes` makes it larger. */
async function submitted(verdict = "pass", extra?: Uint8Array): Promise<string> {
  seq += 1;
  const name = `scan-me-${seq}`;
  const valid = validateZipBundle(
    zipSync({
      "SKILL.md": strToU8(`---\nname: ${name}\ndescription: Scans. Use it.\n---\n# Scan\n`),
      "kobe.skill.yaml": strToU8(
        `apiVersion: kobe.dev/skill/v1\nname: ${name}\nversion: 1.0.0\nsummary: S.\nlicense: MIT\n`,
      ),
      ...(extra ? { "assets/blob.txt": extra } : {}),
    }),
  );
  if (!valid.ok) throw new Error(valid.error.message);
  const b = valid.value;
  const runtimeHash = sha256Hex(b.zip);
  const runtimeKey = await ensureObject(blobs, b.zip, runtimeHash);
  const packageKey = b.packageZip ? await ensureObject(blobs, b.packageZip, b.packageHash) : null;
  const s = await h.admin.query<{ id: string }>(
    `INSERT INTO registry_skills (name, summary) VALUES ($1, 'S.') RETURNING id`,
    [name],
  );
  const v = await h.admin.query<{ id: string }>(
    `INSERT INTO registry_versions (skill_id, semver, seq, runtime_hash, package_hash,
       runtime_storage_key, runtime_size_bytes, package_storage_key, manifest, provenance, source,
       scan, verdict, submitted_by)
     VALUES ($1, '1.0.0', 1, $2, $3, $4, $5, $6, '{}', '{}', '{}', '{"findings": []}',
       $7::scan_verdict, $8)
     RETURNING id`,
    [
      s.rows[0]?.id,
      runtimeHash,
      b.packageHash,
      runtimeKey,
      b.zip.length,
      packageKey,
      verdict,
      ids.submitter,
    ],
  );
  return v.rows[0]?.id as string;
}

const stored = async (id: string) =>
  (
    await h.admin.query<{ scan: { external?: Record<string, unknown> }; verdict: string }>(
      `SELECT scan, verdict::text AS verdict FROM registry_versions WHERE id = $1`,
      [id],
    )
  ).rows[0];

const turn = (on: boolean) =>
  h.admin.query(`UPDATE site_skill_settings SET scanner = $1::jsonb WHERE id = 1`, [
    JSON.stringify({ external: on }),
  ]);

beforeAll(async () => {
  h = await openHarness({ blobs });
  ids.submitter = await h.createUser("submitter@scan.test");
  ids.reviewer = await h.createUser("reviewer@scan.test", "admin");
  await h.admin.query(
    `INSERT INTO teams (id, slug, name, registry) VALUES ($1, 'registry', 'Registry', true)`,
    [registryTeam],
  );
  await h.admin.query(`UPDATE site_skill_settings SET registry_team_id = $1 WHERE id = 1`, [
    registryTeam,
  ]);
  kube = createFakeKube();
  seedCluster(kube);
  kube.afterWrite = (object) => finishJob(kube, object);
});

beforeEach(() => {
  output = resultLine([critical]);
});

afterAll(async () => {
  await h?.close();
});

describe("off by default (ac-1)", () => {
  it("scans nothing until a Site admin turns it on", async () => {
    const id = await submitted();
    expect(await runner().run(id)).toBeNull();
    expect(kube.all("Job")).toEqual([]);
    expect((await stored(id))?.scan.external).toBeUndefined();
  });
});

describe("a scan per submission (ac-1 to ac-4)", () => {
  it("runs a Job in the Registry team's namespace with the package only, reaching nothing", async () => {
    await turn(true);
    const id = await submitted();
    const r = await runner().run(id);
    expect(r).toMatchObject({ status: "done", scanner: "cisco-ai-skill-scanner" });
    const job = kube.all("Job").find((j) => j.metadata.name === `skill-scan-${id}`);
    expect(job?.metadata.namespace).toBe("kobe-team-registry");
    const pod = (job?.spec as { template: { spec: Record<string, unknown> } }).template.spec;
    expect(pod).toMatchObject({ automountServiceAccountToken: false, dnsPolicy: "None" });
    expect(JSON.stringify(job)).not.toMatch(/secret|"env"/i);
    const cm = kube.all("ConfigMap").find((c) => c.metadata.name === `skill-scan-${id}`);
    expect(Object.keys((cm as { binaryData?: object }).binaryData ?? {})).toEqual(["package.zip"]);
    const policy = kube.all("NetworkPolicy").find((p) => p.metadata.name === "kobe-skill-scan");
    expect(policy?.spec).toMatchObject({ ingress: [], egress: [] });

    // Findings shown in review, advisory: Pass rose to Caution and each must be acknowledged.
    const after = await stored(id);
    expect(after?.verdict).toBe("caution");
    const detail = await reviewDetail(h.deps.database.db, id, ids.reviewer);
    expect(detail?.findings).toEqual([
      expect.objectContaining({
        source: "external",
        rule: "cisco:YARA_prompt_injection_generic",
        severity: "caution",
        externalSeverity: "critical",
        acknowledged: null,
      }),
    ]);
    expect(detail?.approveProblems.map((p) => p.code)).toContain("findings_unacknowledged");
  });

  it("never sets Block, and LOW or INFO findings raise nothing", async () => {
    const blocked = await submitted("block");
    await runner().run(blocked);
    expect((await stored(blocked))?.verdict).toBe("block");
    output = resultLine([{ ...critical, severity: "low" }]);
    const low = await submitted();
    await runner().run(low);
    expect((await stored(low))?.verdict).toBe("pass");
  });

  it("records failures, a package too large, and a missing image; Approve waits while it runs", async () => {
    output = "the scanner crashed\n";
    const broken = await submitted();
    expect(await runner().run(broken)).toMatchObject({ status: "failed", reason: "no_result" });
    expect((await stored(broken))?.verdict).toBe("pass");

    const big = await submitted("pass", randomBytes(800 * 1024));
    expect(await runner().run(big)).toMatchObject({ status: "skipped", reason: "too_large" });
    const noImage = await submitted();
    expect(await runner(SETTINGS).run(noImage)).toMatchObject({ status: "unavailable" });

    const running = await submitted();
    await h.admin.query(
      `UPDATE registry_versions SET scan = jsonb_set(scan, '{external}', $2::jsonb) WHERE id = $1`,
      [running, JSON.stringify({ status: "running", startedAt: "2026-01-01T00:00:00Z", job: "x" })],
    );
    const detail = await reviewDetail(h.deps.database.db, running, ids.reviewer);
    expect(detail?.approveProblems.map((p) => p.code)).toContain("external_scan_running");
    // The sweep finishes a scan whose driver died (no Job left): failed, Approve no longer waits.
    expect(await runner().sweep()).toBeGreaterThanOrEqual(1);
    expect((await stored(running))?.scan.external).toMatchObject({
      status: "failed",
      reason: "interrupted",
    });
  });
});
