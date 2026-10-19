# KOBE-341: C12: Optional external scanner (Cisco skill-scanner Job)

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (group branch `group-skills-c`, one PR for Phase C)
- **Branch / worktree:** `group-skills-c` in `../Kobe-skC`
- **Depends on:** KOBE-330 (`site_skill_settings.scanner.external`, off), KOBE-333
  (submissions), KOBE-334 (Caution acknowledgements, Approve), KOBE-93 (the Orbit eval Job pattern)
- **Migrations:** none (the result lives in `registry_versions.scan.external`)
- **Phase C after `db:rebase`** (main 05a92778): the branch's generated migrations are one, 0153;
  its custom ones follow as 0154 (synced-rev backfill), 0155 (dedicated Registry team), 0156
  (promotion requests RLS), 0157 (`from_conversation` backfill), 0158 (review guard for the
  confirmer; fixed in place for versions without a submitter), 0159 (`team_skill_requests` RLS).
  Ledgers, tests and docs use these numbers. `db:rebase` now caps the regenerated name's length.

## What shipped

- **Image** `images/skill-scan` (`kobe-skill-scan`): Cisco skill-scanner **2.2.1** (Apache-2.0,
  LICENSE checked in the repository; PyPI `cisco-ai-skill-scanner`), installed from a
  hash-pinned lock (`requirements.txt`; see the review fixes) and the wheel's PyPI hashes
  (`scanner-requirements.txt`). Python 3.12 slim (digest of 2026-10-06), uid 1000, read-only
  root, no package managers. Kobe's runner (`kobe_skill_scan`) unpacks one package safely (no
  absolute or parent paths, no links or devices, 2000 files, 64 MiB) and runs only the offline
  analyzers (`--use-behavioral`: static rules, YARA, bytecode, dataflow): no LLM judge, VirusTotal,
  AI Defense or OSV; the scanner sees no API keys; it prints one `KOBE_EXTERNAL_SCAN` line with
  rule, severity, category, title, file, line (no snippets). `test-image.sh`: uid, offline scan of
  a planted package, a parent-path package refused, no credentials in the environment. Built and
  tested on the remote amd64 host; scanning takes ~13 s.
- **Licences:** `images/skill-scan/third-party-licenses.json` (collected from the built image),
  inventory row `skill-scan` (image report) and the Python base row; `pnpm licenses:update`.
  Pending gate review: see the review fixes. CI `skill-scan-image.yml` builds, tests, audits
  licences and runs Trivy.
- **Chart:** `sandbox.skillScan {deadlineSeconds: 300, resources}`; the server gets the
  `kobe-skill-scan` image, deadline and limits (`KOBE_SANDBOX_CONFIG.skillScan`).
- **Server** (`skills/registry/external-scan*.ts`): with `scanner.external` on, each submission
  (direct or a confirmed request) starts a Job **in the Registry team's namespace** (SK21):
  gVisor/Kata (verified), no service account token, no Secret, no env, `dnsPolicy: None`, no host
  aliases, the package from ConfigMaps (in parts), read-only root,
  a TTL, and the NetworkPolicy `kobe-skill-scan` that allows **no ingress and no egress**; the
  team's sandbox policy now leaves skill-scan pods out (policies are additive). The result line
  goes into `scan.external` (`running` → `done` | `failed` | `skipped` | `unavailable`).
- **Advisory:** MEDIUM, HIGH and CRITICAL findings become Caution findings (`cisco:<rule>`),
  acknowledged one by one like Kobe's own before Approve, and raise a Pass verdict to Caution;
  LOW and INFO are shown only. Block is never set (a Block verdict stays Kobe's). A decided version
  keeps its verdict. Approve waits for the scan (`external_scan_running`). A sweep (every minute,
  any replica) starts lost scans and finishes those whose driver died.
- **Web:** the review screen's Scan section shows the external scanner's state and findings apart
  ("External scanner (advisory): cisco-ai-skill-scanner 2.2.1"), with Acknowledge on Caution ones.

## Decisions

- **No egress at all** in v1: the optional LLM judge (SK32: "uses the gateway and the Registry
  team budget") is not wired; turning it on needs a gateway token and a policy to the gateway, as
  the Orbit eval has. A follow-up, not a setting.
- Version 2.2.1 (published 2026-10-05) rather than 2.3.0 (four days old).
- The result is read from the pod log (as the Orbit eval); no volume or callback.

## Review fixes (review-341.md; coordinator decisions)

- **M1** the submission records `scan.external = queued` when the Site has the scanner on (in its
  transaction); Approve waits while `queued` or `running`; the sweep starts a scan queued over a
  minute (a lost start); a server without a runner records `unavailable` (`no_runner`).
- **M2** a scan that failed, was skipped or couldn't run is one Caution item
  (`cisco:scan_incomplete@:0`, its reason in the title) to acknowledge, and raises Pass to
  Caution; never Block. The package goes in parts (≤ 700 KiB each, up to 8: the 5 MiB maximum)
  across ConfigMaps mounted as one projected volume, so size no longer skips a scan.
- **pcodedmp** (coordinator): left out of the lock (never imported: the scanner uses
  `oletools.oleid` only); `test-image.sh` asserts it is absent.
- **L5** the Job is created first and its ConfigMaps are owned by it from creation; a failed start
  deletes the Job. **L6** base image of 2026-10-06 (libpcre2 deb13u3) and fsspec 2026.6.0: Trivy
  shows no CRITICAL; the remaining fixable HIGHs are the upstream CEL helper's Go runtime
  (CVE-2026-78667, -78669, -97031; no network in the Job; fixed when the scanner rebuilds it).
  The other images keep their base digest (unchanged here). **L7** the lock is the scanner's
  `uv.lock` exported without extras (no cloud or LLM SDKs); pending licences 11 → 6.
  **L8** inventory row `skill-scan-cel-go` for the bundled Go helper. **L9** at most two scans
  run at once (advisory-locked claim); more wait queued. **L10** `sandbox.skillScan.enabled`
  (default false) gives the server the image; without it a scan records `unavailable`.

## Open questions (for Chris or the coordinator)

- **Gate review:** 6 pending licence entries (protobuf, multidict, regex, tiktoken,
  typing_extensions, aiohappyeyeballs): permissive licences under non-SPDX labels; five were
  approved for other versions in the Orbit image.
- The image is not in the publish workflow (like `orbit-eval`).

## Evidence (acceptance criteria → test or command output)

- **ac-1** `services/server/src/skill-external-scan.db.test.ts` "off by default" (no Job) and "a
  scan per submission" (a Job in the Registry team's namespace; findings in the review detail with
  `source: external`); web `components/admin/skill-review-console.test.tsx`.
- **ac-2** same file and `skills/registry/external-scan-job.test.ts`: the NetworkPolicy has no
  ingress or egress, no DNS, no host aliases; `images/skill-scan/test-image.sh` scans with
  `--network none`.
- **ac-3** `skills/registry/external-scan-result.test.ts` (Pass → Caution; Caution and Block
  unchanged; LOW/INFO raise nothing) and the DB file (a Block version stays Block).
- **ac-4** the Job manifest test (no token, Secret, env) and the licence check
  (`pnpm license:check`: passes with the pending warnings).
