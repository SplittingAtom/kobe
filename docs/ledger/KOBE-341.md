# KOBE-341: C12: Optional external scanner (Cisco skill-scanner Job)

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (group branch `group-skills-c`, one PR for Phase C)
- **Branch / worktree:** `group-skills-c` in `../Kobe-skC`
- **Depends on:** KOBE-330 (`site_skill_settings.scanner.external`, off), KOBE-333
  (submissions), KOBE-334 (Caution acknowledgements, Approve), KOBE-93 (the Orbit eval Job pattern)
- **Migrations:** none (the result lives in `registry_versions.scan.external`)

## What shipped

- **Image** `images/skill-scan` (`kobe-skill-scan`): Cisco skill-scanner **2.2.1** (Apache-2.0,
  LICENSE checked in the repository; PyPI `cisco-ai-skill-scanner`), installed from the release's
  hash-pinned lock (`requirements.txt`, `uv export --all-extras`) and the wheel's PyPI hashes
  (`scanner-requirements.txt`). Python 3.12 slim (the Orbit image's digest), uid 1000, read-only
  root, no package managers. Kobe's runner (`kobe_skill_scan`) unpacks one package safely (no
  absolute or parent paths, no links or devices, 2000 files, 64 MiB) and runs only the offline
  analyzers (`--use-behavioral`: static rules, YARA, bytecode, dataflow): no LLM judge, VirusTotal,
  AI Defense or OSV; the scanner sees no API keys; it prints one `KOBE_EXTERNAL_SCAN` line with
  rule, severity, category, title, file, line (no snippets). `test-image.sh`: uid, offline scan of
  a planted package, a parent-path package refused, no credentials in the environment. Built and
  tested on the remote amd64 host; scanning takes ~13 s.
- **Licences:** `images/skill-scan/third-party-licenses.json` (collected from the built image),
  inventory row `skill-scan` (image report) and the Python base row; `pnpm licenses:update`.
  **11 packages are `pending: gate review`** (`images/skill-scan/license-exceptions.json`): free-text
  labels of permissive licences (protobuf, google-cloud-aiplatform/-bigquery, multidict, tiktoken,
  uritemplate), PSF/Python-2.0 (typing_extensions, aiohappyeyeballs), regex (CNRI-Python),
  google-crc32c (no metadata, Apache-2.0), and **pcodedmp (GPL-3.0)**, oletools' VBA p-code
  disassembler. CI `skill-scan-image.yml` builds, tests, audits licences and runs Trivy.
- **Chart:** `sandbox.skillScan {deadlineSeconds: 300, resources}`; the server gets the
  `kobe-skill-scan` image, deadline and limits (`KOBE_SANDBOX_CONFIG.skillScan`).
- **Server** (`skills/registry/external-scan*.ts`): with `scanner.external` on, each submission
  (direct or a confirmed request) starts a Job **in the Registry team's namespace** (SK21):
  gVisor/Kata (verified), no service account token, no Secret, no env, `dnsPolicy: None`, no host
  aliases, the package from a ConfigMap (≤ 700 KiB; larger is recorded `skipped`), read-only root,
  a TTL, and the NetworkPolicy `kobe-skill-scan` that allows **no ingress and no egress**; the
  team's sandbox policy now leaves skill-scan pods out (policies are additive). The result line
  goes into `scan.external` (`running` → `done` | `failed` | `skipped` | `unavailable`).
- **Advisory:** MEDIUM, HIGH and CRITICAL findings become Caution findings (`cisco:<rule>`),
  acknowledged one by one like Kobe's own before Approve, and raise a Pass verdict to Caution;
  LOW and INFO are shown only. Block is never set (a Block verdict stays Kobe's). A decided version
  keeps its verdict. Approve waits while a scan runs (`external_scan_running`). A sweep (every
  minute, any replica) finishes scans whose driver died.
- **Web:** the review screen's Scan section shows the external scanner's state and findings apart
  ("External scanner (advisory): cisco-ai-skill-scanner 2.2.1"), with Acknowledge on Caution ones.

## Decisions

- **No egress at all** in v1: the optional LLM judge (SK32: "uses the gateway and the Registry
  team budget") is not wired; turning it on needs a gateway token and a policy to the gateway, as
  the Orbit eval has. Recorded as a follow-up, not a setting.
- Version 2.2.1 (published 2026-10-05) rather than 2.3.0 (four days old).
- The result is read from the pod log (as the Orbit eval); no volume or callback.

## Open questions (for Chris or the coordinator)

- **Gate review:** the 11 pending licence entries, above all **pcodedmp (GPL-3.0)**: accept it in
  this optional image, or build the image without it (olevba then skips VBA p-code analysis).
- The image is not in the publish workflow (like `orbit-eval`); a site wanting the scanner builds
  and imports it, or it is added to publishing at the gate.

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
