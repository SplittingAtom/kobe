# KOBE-82: 49e: Materialize effective skills into the sandbox and register them with Pi

- **Status:** in review
- **Branch / worktree:** `kobe-82-skill-materialization` in `../Kobe-wt82`
- **Depends on:** KOBE-76 (resolver at run start), KOBE-78 (canonical zip), KOBE-80/81 (approval, blocklist)
- **Migrations:** none.

## Decisions

- **Delivery: HTTP on the server's sandbox listener, not the WSS frames.** `GET /v1/sandbox/skills/<sha256>`
  with the sandbox's `kobe.sandbox-wire` token (same listener, auth and NetworkPolicy path as workspace
  sync, KOBE-27). The sandbox holds no S3 credentials, URL or key. Frames are capped at 4 MiB and a stored
  (uncompressed) canonical zip can reach ~25 MiB, so chunking over the wire would have meant a new multi-part
  command protocol; HTTP streams.
- **Authorization without a new secret or table.** (team, user) come from the verified token; in one
  transaction the server serves a hash only if it is effective for that caller now (`skills/materialize.ts`
  `locateBundle`): an approved team version, or one of the caller's usable personal versions while the team
  has not switched personal skills off; the blocklist is read again in the same transaction. Anything else
  (pending, rejected, blocklisted, other team, other user's personal skill, junk) is the same 404. The stream
  is hash-verified on the way out (`verifyingStream`). Not a per-run signed grant: a compromised sandbox
  could fetch any skill currently effective for its own user and team, which every member can already
  download. Per-sandbox rate limit (200 burst, 20/s).
- **`run.start.config.skill_bundles: [{name, sha256, size}]`** (additive, optional;
  `packages/protocol/src/sandbox-wire/skill-bundles.ts`, documented there). `skills` (names) stays and always
  equals the bundle names. A sandbox agent older than this change rejects the strict frame, so server and
  image roll out together. Built in `PINNED_AGENTS.resolve` from the resolver's output, inside the run-start
  transaction, with the blocklist (`blockedAmong`) read once more; nothing but these refs is ever listed.
- **Sandbox side** (`services/sandbox-agent/src/skills/`): `SkillStore.prepare(thread, refs)` fetches each
  bundle, requires exact size and SHA-256 equal to the frame's, then `readBundle` re-applies the safety rules
  on the canonical form only: stored entries (no deflate/zip64/encryption/data descriptors), no comment,
  junk or gaps, local header = central header, CRC checked, regular files only (symlink/device/fifo mode
  bits refused), safe NFC paths (no `..`, absolute, backslash, control chars, `__proto__`, case-duplicates,
  file-under-file), caps 200 files / 10 MiB per file / 25 MiB total / 100 KiB SKILL.md / 240-byte paths,
  SKILL.md at the root. Extraction: temp dir, `O_EXCL|O_NOFOLLOW`, then atomic rename.
- **Where and who:** `KOBE_SKILLS_DIR=/run/kobe-skills`, a second memory-backed emptyDir (128 Mi; the agent
  caps all live skills at 96 MiB) next to `/run/kobe-pi`, so its root is sticky and no Pi uid can rename the
  agent's directories (`ensureRuntimeRoot`, KOBE-71; the agent refuses a root that isn't). Content is
  `sk-<sha256>/`, owned by the agent (uid 1000), dirs 0755 and files 0644 set explicitly (agent umask is 077),
  so Pi/tool uids read and traverse but can't write, rename or delete. The path must be on another filesystem
  than `/workspace` (same guard as the Pi runtime dir). The unused image dir `/opt/kobe/skills` is left alone.
- **Registration with Pi 1.0.0:** documented `--skill <path>` (repeatable; explicit paths still load under
  `--no-skills`, which stays on so nothing is discovered from `$HOME`/`.pi`). One `--skill <dir>` per effective
  skill, in the resolver's order. Verified against the real pinned Pi: `get_commands` lists `skill:demo`
  with the flag and not without (`agent.real-pi.test.ts`). The skill hashes are part of Pi's launch key, so a
  changed skill set restarts the thread's idle Pi.
- **No stale skills:** each start sets the thread's wanted hashes and removes every `sk-*` no live thread
  wants (so an empty list empties the store); `release` on idle reap/eviction; the whole root is emptied at
  agent boot (a pod restart keeps the emptyDir). Starts are serialized in one queue.
- **Failures:** missing store, hash/size mismatch, unsafe bundle, a bundle the server no longer offers, or a
  stale directory that can't be removed fail `run.start` with `pi_unavailable` ("skills: ..."), starting no Pi;
  a `skills` name without a bundle is `pi_rejected`. Fail closed, no Pi without the vouched skills.
- Duplicated on purpose: the small strict zip reader (the server's lives in `services/server`, which the
  sandbox can't import). A canonical zip made by the server's packer is a test fixture.

## Open questions (for Chris or the coordinator)

- Executable bits are not preserved (the canonical zip drops attributes): scripts run via an interpreter,
  not `./script.sh`. Needs a canonical-format change in KOBE-78 if wanted.
- A personal skill replaced by a newer version between run start and fetch gets a 404 and fails that run
  (strict "effective now"); retrying the run picks the new version.
- No chart or NetworkPolicy change needed (the sandbox listener port is already allowed).

## Evidence (acceptance criteria -> test or command output)

- ac-1 (only effective skills): `services/server/src/skill-materialization.db.test.ts` (run.start lists only
  approved ones with hash and size; download serves only effective hashes); sandbox
  `src/agent.skills.test.ts` (exact `--skill` list, removal on the next run) and
  `skills/store.test.ts` (stale removal, read-only modes, hash/size mismatch, unsafe entries).
- ac-2 (blocklisted/team-disabled never materialize): same server file (blocklist at run start and at
  download, personal switch at both); `bundle.test.ts` for the sandbox-side safety rules.
- Pod spec: `sandbox/manifests.test.ts`. Frames: `sandbox-wire/frames.test.ts`.
