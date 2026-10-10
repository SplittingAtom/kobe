# KOBE-146: 53f Optional ClamAV scan and upload e2e

- **Status:** in review
- **Branch / worktree:** `kobe-146-clamav-upload-e2e` in `../Kobe-wt146`
- **Depends on:** KOBE-143 (upload API, scan seam), KOBE-144 (submit with files)

## Plan

No migration. `uploads/clamd.ts` (INSTREAM client + `UploadScanner`), settings from env, chart wiring,
audit event, tests with a fake clamd, an upload section in `e2e/run.sh`. Tests first.

## Decisions

- **Flow:** `POST /v1/uploads` stores the object in S3 (143), then `createClamdScanner` reads it back and
  streams it to clamd (`zINSTREAM`, 64 KiB chunks, never in memory or on disk), before the `files` row.
  Why after, not tee during the write: the seam is "scan the stored object", and a hit then deletes
  exactly one known key. Cost: one extra S3 read of the file.
- **Fail closed:** only `stream: OK` is clean. A `FOUND` reply is `scan_rejected` (422); anything else
  (refused, timeout, clamd `ERROR` such as the size limit, unreadable reply, S3 read failure, missing
  object) is `scan_unavailable` (503). Both delete the object and leave no `files` row. Scanning is on
  when `KOBE_CLAMAV_HOST` is set (chart: `clamav.enabled`); off = nothing changes (`scan: skipped`).
- **Audit:** new `workspace.upload_scan_refused` {userId, reason scan_rejected|scan_unavailable, bytes}
  (naming follows the other `workspace.upload_*` events, not `upload.scan_rejected`); no name, content or
  signature (the signature name goes to the server log only). Documented in `docs/audit-log.md`.
- **clamd limits (chart ConfigMap `clamd.conf`):** `StreamMaxLength` and `MaxFileSize` = max(file, message)
  upload limit, `MaxScanSize` 4x, `AlertExceedsMax yes`: what clamd cannot scan in full is reported as a
  hit, not silently skipped. Real ClamAV only flags EICAR when it is the whole file (a prefix hides it).
- **Non-root (checked on the real image `clamav/clamav:1.4`, remote Docker host):** the image's default is
  root (`/init`), but it ships `/init-unprivileged`. The pod runs it as uid 100 / gid 101 (`clamav`), all
  capabilities dropped, no privilege escalation, read-only root filesystem; emptyDirs for the signature DB
  (`/var/lib/clamav`, downloaded by freshclam at start), `/tmp` and `/var/log/clamav`; `clamd.conf` mounted
  read-only. Verified there with `--read-only --user 100:101 --cap-drop ALL`: clamd starts, the Kobe client
  scans clean/EICAR/5 MB correctly against it. Startup probe allows ~15 min for the DB download (until
  then uploads fail closed with 503). Egress is not restricted (freshclam needs database.clamav.net).
- **NetworkPolicy:** `<release>-clamav` admits only the server pods, TCP 3310 (was: any pod in the
  namespace). Sandboxes live in team namespaces and are not selected either way.
- **Licence:** ClamAV is GPL-2.0 and is only run as a separate service image (`docker.io/clamav/clamav`);
  no ClamAV code is linked or bundled into a Kobe image, and the server talks to it over TCP. Already
  listed in `docs/licensing.md`. `tools/license-check` checks npm/pip dependencies only; this PR adds no
  dependency, so nothing is flagged.
- **e2e (ClamAV off in PRs):** the real image needs a ~300 MB pull, a ~250 MB signature download from
  database.clamav.net (rate limits, minutes) and 1 GiB memory per cluster, so PR runs keep it off. The
  `suite` shard gets an "uploads" section after the artifacts story: upload into a thread (201, skipped),
  2 MiB refused (413 file_too_large; `dev/values.yaml` sets `maxFileBytes` 1 MiB), object in S3, a message
  with the file (CHAT_JS gained a `file_ids` argument), the Owner's real sandbox reads
  `/workspace/uploads/<thread>/e2e-upload.txt` through the fake model's bash tool call, Delete forever of
  the thread removes the object and row. Added PR CI time: roughly 1.5-2 min (one sandbox run + a purge).
  With `KOBE_E2E_CLAMAV=1` (nightly and manual runs of the `suite` shard) the section also upgrades the
  chart with `clamav.enabled=true`: EICAR rejected + audited + no row, clean file passes (`clean`), clamd
  scaled to 0 gives 503 `scan_unavailable`; adds about 5-10 min there. Not run locally (no k3d here):
  CI is the first run.

## Open questions (for Chris or the coordinator)

- Should PRs that touch `charts/kobe/templates/clamav.yaml` or `services/server/src/uploads/clamd.ts` also
  run the ClamAV phase (workflow condition on changed paths)? Left to the nightly to keep PR CI short.
- Scanning reads each file back from S3 once more; a tee during the upload would save that read but
  couples the scan to the upload stream. Fine at the 100 MiB default limit?

## Evidence (acceptance criteria → test or command output)

- ac-1: `uploads-scan.db.test.ts` (EICAR: 422, no row, object deleted, audit row); `uploads/clamd.test.ts`.
- ac-2: `uploads-scan.db.test.ts` (clamd down: 503 `scan_unavailable`, nothing stored);
  `uploads.db.test.ts` "scan seam" and every other upload test run with scanning off.
- ac-3: `e2e/run.sh` "uploads (KOBE-146)"; chart tests `ClamAV` and `network policies` in
  `charts/kobe/tests/render.test.ts`.
