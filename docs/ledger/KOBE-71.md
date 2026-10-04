# KOBE-71: Sandbox privilege separation (Pi and tool code under their own uids)

- **Status:** in review (PR pending)
- **Branch / worktree:** `kobe-71-privilege-separation` in `../Kobe-wt71`
- **Depends on:** KOBE-21/22/23/25/27/36/41 (merged)

## Acceptance criteria (Hadron KOBE-71)

1. **ac-1** Pi and the tools it runs execute under a uid that cannot read or write
   kobe-sandbox-agent's token files or another thread's runtime dir.
2. **ac-2** A test plants files from one thread's tool process into another thread's runtime dir
   and fails with a permission error.
3. **ac-3** Cold start (Pi ready) does not regress by more than 10% on CI k3d.

Coordinator brief on top: no reading the agent's tokens, no signalling/ptrace of the agent or
siblings, model token + run id unalterable by a sibling, /workspace still shared (D13) and KOBE-27
sync working, gVisor + runAsNonRoot, no capabilities if at all possible (else justify), Pi 1.0.x
RPC unchanged, tests for planting/reading/killing/tripwire, and the KOBE-41/42 notes below.

## Design

| Who                                           | uid    | gid    | supplementary                     |
| --------------------------------------------- | ------ | ------ | --------------------------------- |
| kobe-sandbox-agent (`kobe`)                   | 1000   | 1000   | 1000 (fsGroup), 1001, 2000–2015   |
| each Pi process and its tools (`kobe-pi-<n>`) | 2000+n | 2000+n | 1000 (the shared workspace group) |

- **One identity per live Pi process**, from a pool (the agent's supplementary groups in
  2000–2063; the pod gives 16, more than the agent's process cap of 8, so a new Pi never waits for
  a reclaim). `pi/identities.ts` hands one out per spawn and takes it back only after
  `kobe-runas <uid> --kill-all` found no process of that uid left (Pi, every tool, double-forked
  escapees: `kill(-1)` as that uid reaches exactly them) and its runtime dir is gone. A failed
  reclaim keeps the identity out of use for good (fail closed). This replaces the best-effort
  /proc descendant walk for Pi identities.
- **`kobe-runas`** (`images/sandbox/runas/kobe-runas.c`, ~200 lines, static): the only privileged
  file in the image. `cap_setuid,cap_setgid=ep`, mode `0750 root:kobe-agent`, so only the agent can
  execute it; it also checks the caller's uid. It switches to the target identity (uid range
  compiled in), sets the groups to exactly {target, 1000}, umask 002, drops every capability
  (capset to zero, ambient cleared, verified with capget), sets `no_new_privs`, verifies it cannot
  regain uid 1000, and execs. Pi's stdio and its policy socket (fd 3) are inherited unchanged: the
  wire protocol and the Pi RPC protocol are **unchanged**. The helper runs in secure-execution mode
  (file capabilities), where glibc drops `TMPDIR` from the environment it passes on; the agent
  re-sets it through `env(1)` (found by the real-helper test).
- **Runtime dir per Pi** (`/run/kobe-pi/pi-XXXXXX/`): agent-owned, group = the Pi's own gid,
  `2750` (setgid); `model.json` `0640` (only that Pi reads it, only the agent writes it);
  `agent/` (Pi's `PI_CODING_AGENT_DIR`) `2770`, the only place the Pi may write (Pi 1.0.0 must
  write `auth.json`/`models-store.json` and their lock dirs there, KOBE-41). `/run/kobe-pi` is a
  **memory-backed emptyDir** (64 MiB): its root is sticky (`3777`, measured under gVisor) and a
  mount point, so no identity can rename the agent's directories. On the disk-backed `/tmp`
  (`2777`, no sticky bit) any identity could rename `/tmp/kobe-pi` and put its own directory at
  the path another Pi reads its config and model file from — found while testing; the agent now
  refuses a runtime root that any directory above lets others rename (`ensureRuntimeRoot`).
- **Agent files**: the bootstrap token is mounted under `/run/kobe-agent/bootstrap`, inside the
  image's agent-only `/run/kobe-agent` (`0700`). The projected file itself is `0640` with the pod's
  fsGroup, which every identity shares (the workspace group), so the parent is what keeps sandbox
  code out. Session tokens (wire, model gateway, egress, MCP) live in agent memory; identities can
  neither read `/proc/<agent>/*` nor ptrace or signal it (different uid; verified under gVisor).
- **/workspace stays shared** (D13): every identity has the workspace group 1000; Pi runs with
  umask 002; KOBE-27 sync now writes `0664`/`0775`; the agent's session dir is `2770` with `0660`
  files (it fixes modes left by older agents, once per process, through file handles). The kubelet's
  fsGroup pass on every mount makes older files group-writable as well. `$HOME` (`/home/kobe`) and
  `/tmp` stay shared like before (see residual risks).
- **Confused-deputy guard** (`workspace/volume.ts`): the agent can reach files the identities
  cannot (other Pis' dirs, the token). Every file it reads or writes under /workspace (sync
  downloads/uploads/hashes, session restore, branch markers) is opened first (`O_NOFOLLOW`,
  `O_NONBLOCK`) and checked to be on the workspace volume's device; writes, chmod and utimes go
  through that handle. A parent swapped for a symlink between the agent's checks and its open can
  therefore never make it read or write another Pi's runtime dir or the token (they are on other
  filesystems; the agent refuses to start in identity mode if the runtime dir shares the workspace
  filesystem). Renames stay on one filesystem. Left: removing/renaming/chmod-ing an agent-owned
  entry elsewhere by name through a swapped parent (a denial of service against the user's own
  other threads, which their tripwire then reports).
- **Fail closed**: Kobe's pod spec sets `KOBE_PI_RUNAS`; the agent then checks the helper (root-
  owned, not group/world-writable), needs one identity group per allowed Pi process, runs one real
  switch (`/bin/true`) at start-up and verifies the runtime dir is not on the workspace filesystem.
  Any failure stops the agent; it never falls back to running Pi as itself. Without
  `KOBE_PI_RUNAS` (development, tests outside the image) Pi runs as the agent, with a warning.

### Why file capabilities, and Pod Security "baseline" (the capability decision)

Pod Security "restricted" (KOBE-22) allows no way at all for one container to have two uids: no
capability but `NET_BIND_SERVICE`, `allowPrivilegeEscalation: false` (no_new_privs, so no setuid or
file-capability binary works), non-root. Options evaluated, each measured on the cluster's gVisor
(`runsc` release-20260928.0, the same release CI's k3d installs):

| Option                                                | Verdict                                                                                                                                                                                                               |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stay "restricted": second container for Pi/tools      | Not per thread (a container per thread would split the pod's memory limit 8 ways), needs a stdio/fd-3 relay across containers over a shared socket the tools could reach too. Rejected.                               |
| Unprivileged user namespaces                          | A non-root process can map only its own uid: no second uid. Rejected.                                                                                                                                                 |
| Landlock / Node permission model                      | Not implemented by gVisor / does not cover child processes. Rejected.                                                                                                                                                 |
| setuid-root helper (`4750`)                           | gVisor did not grant the switch (`setgroups: EPERM`, measured). Rejected.                                                                                                                                             |
| Agent holds `CAP_SETUID` itself (Node `spawn({uid})`) | A non-root container process gets empty permitted/effective sets (measured `CapPrm 0`, `CapBnd 0xc0`); it would need file caps on a copy of `node`, i.e. the whole agent privileged. Rejected for the smaller helper. |
| **File-capability helper `kobe-runas`** (chosen)      | Works under gVisor with `allowPrivilegeEscalation: true` and `SETUID`/`SETGID` in the bounding set; refused with `allowPrivilegeEscalation: false` (measured).                                                        |

So the sandbox container now has `allowPrivilegeEscalation: true` and
`capabilities: {drop: [ALL], add: [SETUID, SETGID]}`, and team namespaces are Pod Security
**"baseline"** (the server labels them; the chart's server-scope admission policy accepts
baseline or restricted). Everything else "restricted" requires is enforced by Kobe's own
admission policy for team pods (`sandbox-admission.yaml` policy 2: drop ALL and add at most
SETUID/SETGID, never privileged, non-root, seccomp RuntimeDefault/Localhost, restricted volume
types), checked against a real API server (k3s 1.34) with dry-run pods: the sandbox shape
passes; extra `CHOWN`, no drop ALL, root, no seccomp, an NFS volume are refused by the policy and
`NET_ADMIN`/privileged by Pod Security itself. Why this is acceptable:

- The agent process itself has **no capabilities** (`CapEff 0`, e2e checks it); only the helper
  gains two while it switches, and everything Pi starts runs with none and `no_new_privs`, so a
  tool can never gain privileges through any binary again.
- Under gVisor (and Kata) these are capabilities of the sandbox kernel, not of the host; the
  isolation boundary, NetworkPolicy and seccomp are unchanged (the seccomp profile is still
  RuntimeDefault).
- The only file with capabilities is `kobe-runas` (test-image asserts it), executable only by
  `kobe-agent`; no setuid/setgid files exist.

## Decisions

- **Identity = per live Pi process, not per thread id**: identities are reused across threads, so
  reuse waits for `--kill-all` + removal. Per-thread fixed uids would need unbounded uids or a
  thread → uid table that survives restarts, for no extra guarantee.
- **HOME and /tmp stay shared** (as before KOBE-71). A per-Pi HOME on disk would have to live on
  the non-sticky `/tmp`/`/home/kobe` emptyDirs (renameable by any identity, the bug above), and a
  memory-backed one would make `pip install --user` eat the pod's memory. It would not close the
  cross-thread channel anyway: /workspace is shared by design (D13); see residual risks.
- `KOBE_PI_RUNTIME_DIR=/run/kobe-pi` and the 64 MiB memory volume are constants in the server's
  pod spec (`PI_RUNTIME_DIR`, `PI_RUNTIME_SIZE`), not chart values: nothing but Pi's tiny stores
  and model files go there.
- The agent's own uid stays 1000 (the workspace volume and legacy files keep their owner; the
  pod's `runAsUser` is unchanged). Identities 2000–2063 have `/etc/passwd` entries
  (`kobe-pi-<n>`) so tools that look the user up (git, ssh, Python `getpass`) work.
- Pi's `--version` probe at start-up runs as the agent (no tools) with `HOME` set to its private
  probe dir, so nothing on the world-writable home volume reaches it.
- CI: `ci.yml` `checks` runs `services/sandbox-agent/scripts/test-identities.sh` (builds the
  helper for the runner's uid, installs it root-owned with file caps via sudo, runs the real-helper
  suite with the identity groups). It needs sudo on the runner (GitHub-hosted: yes; a self-hosted
  runner without sudo would fail this step).

## Evidence (acceptance criteria → test or command output)

| AC / item                                           | Evidence                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ac-1 own uid, no agent tokens, no other runtime dir | `identities.real.test.ts` (real helper, real kernel): "runs every Pi under its own identity, never the agent's uid", "a tool cannot read the agent's token file", "…cannot plant…", "…cannot rewrite its own Pi's model file"; e2e (k3d, gVisor, the real agent after a real model run): Pi uid 20xx, dir `kobe:kobe-pi-N 2750`, token/model reads denied |
| ac-2 planting fails with a permission error         | `identities.real.test.ts` "a tool cannot plant a file in another thread's runtime directory (EACCES)" (a real tool process of thread A writes `settings.json` into thread B's `agent/`: `Permission denied`, file absent); e2e "another identity cannot plant a file in that Pi's runtime dir (EACCES)" under gVisor                                      |
| no signal / ptrace of agent or siblings             | `identities.real.test.ts` "a tool cannot signal the agent or another thread's Pi" (`kill -0 agent`, `kill -9 <B's Pi>`, `/proc/<B's Pi>/environ`: all refused; B serves its next run); e2e `signal=2`; gVisor probes (below): ptrace and `/proc/<pid>/mem` refused even within one uid toward an ancestor                                                 |
| tripwire still works                                | `identities.real.test.ts` "keeps the tripwire: a Pi's own tools planting config into its runtime dir fail the next run" (`runtime_tampered`); the KOBE-41 tripwire tests (`agent.models.test.ts`, `runtime-dir.test.ts`) unchanged and green                                                                                                              |
| reclaim                                             | `identities.real.test.ts` "kills everything a Pi left running and empties its directory before the identity is reused"; test-image "--kill-all ends every process of the identity, nothing else"                                                                                                                                                          |
| /workspace shared                                   | `identities.real.test.ts` "shares the workspace between threads" (thread B appends to thread A's file, the agent rewrites it); sync tests with the new modes (`sync.test.ts`, 0775 executables)                                                                                                                                                           |
| helper                                              | `images/sandbox/test-image.sh`: only file with capabilities (`cap_setgid,cap_setuid=ep root:kobe-agent 750`); switch gives uid/gid/groups `1000,2000`, `CapPrm/CapEff 0`, `NoNewPrivs 1`, umask 0002; a Pi identity cannot run it; any other caller refused; uids 0/1000/2064 refused; agent refuses to start without the capability                      |
| admission                                           | chart test "enforces 'restricted' on team pods but for SETUID/SETGID…"; dry runs against k3s 1.34 (above); e2e "admission refuses a team container adding any other capability", "…running as root"                                                                                                                                                       |
| unit                                                | `pi/identities.test.ts`, `workspace/volume.test.ts` (off-volume open refused, Linux), `models/runtime-dir.test.ts` (root ownership, renameable ancestors refused), `pi/session-files.test.ts` (shared modes), `config.test.ts`, server `manifests.test.ts`/`provider.test.ts`                                                                             |
| ac-3 cold start                                     | see "Cold start" below                                                                                                                                                                                                                                                                                                                                    |

### gVisor measurements (cluster, scratch namespace, image built from this branch)

- `runAsUser 1000` with `capabilities.add [SETUID, SETGID]`: `CapPrm/CapEff 0`, `CapBnd 0xc0`;
  Yama `ptrace_scope 1`.
- File-capability helper: switches with `allowPrivilegeEscalation: true`, refused (`setgroups:
EPERM`) with `false`; a setuid-root copy does not switch at all.
- As identity 2000 against: the agent (uid 1000) — `/proc/<pid>/maps`, `environ`, ptrace, `kill`
  all refused; identity 2001 — same; another process of the same uid that is not a descendant, its
  own ancestor, a sibling — `/proc/<pid>/mem` and ptrace refused, `environ` and `kill` allowed.
- Pod as built here (PVC workspace, emptyDirs, projected token under `/run/kobe-agent`): identity
  2000 cannot read the token, nor read, list or write identity 2001's runtime dir (it can list
  the names in the sticky `/run/kobe-pi` root, which gains it nothing);
  2001 can read its own `model.json`, write its `agent/`, but not replace `model.json`; files in
  /workspace written by one identity are writable by the other and by the agent; `--kill-all`
  leaves nothing; `/tmp` 2777 (any identity renames entries), the memory emptyDir 3777 (rename of
  another's entry: `Operation not permitted`); `/tmp`, `/workspace`, `/run/kobe-pi`, the token
  mount are four different devices.

## Self security review (security-reviewer agent: 0 CRITICAL/HIGH, 5 MEDIUM, 8 LOW) — resolution

1. MEDIUM Yama only measured under gVisor (Kata guest kernels): the agent now refuses identity
   mode unless `/proc/sys/kernel/yama/ptrace_scope` ≥ 1 (a tool must not ptrace its own Pi, which
   hosts kobe-policy and fd 3).
2. MEDIUM device guard incomplete: start-up also requires the bootstrap token's directory to be
   on another filesystem than /workspace (fail closed). The create-then-check order in
   `writeFileAtomic`/`SessionRestore` stays (an `O_EXCL` empty file with a random name may land
   off-volume before the check refuses it: denial of service only, residual risk 4).
3. MEDIUM identities burnt by a fork storm: reclaim retries `--kill-all` with backoff for about a
   minute (`killAllPatiently`) before giving the identity up.
4. MEDIUM ephemeral containers: the pods policy also matches `pods/ephemeralcontainers` UPDATE and
   checks `ephemeralContainers` (verified: `kubectl debug --profile=baseline` refused on k3s 1.34).
5. MEDIUM session files writable across threads: added to residual risks (they were writable by
   every thread before KOBE-71 too; restores come from Postgres, mirrored entries stay untrusted on
   the server, KOBE-23).
6. LOW: `--kill-all` reads the real uid from `/proc/<pid>/status` (a non-dumpable process's
   `/proc` entry is root-owned); the start-up sweep is best effort per entry and removes a planted
   directory as its owner identity; `models-store.json` is read through `O_NOFOLLOW|O_NONBLOCK`
   - `fstat`; a failed spawn releases its identity only after its directory is gone; a Kobe pod
     (bootstrap token) without `KOBE_PI_RUNAS` refuses to start; kobe-runas closes fds ≥ 4 before
     exec and is built `-static-pie`, full RELRO; a stale comment fixed. The sticky root is a
     property of the memory emptyDir (gVisor measured 3777); a runtime that does not make it
     sticky makes the agent refuse to start (fail closed), not run unprotected.

## Cold start (ac-3)

Baseline (main, merge-queue e2e run 37179221413): hibernated → Pi ready back-to-back p50 4381 /
p95 4652 ms, spaced p50 3373 / p95 4309 ms; hibernated → first token p50 4778 / p95 5518 ms.
What KOBE-71 adds on that path: one helper exec at agent start (the `/bin/true` probe), and per Pi
start a `chown`/`chmod` of its runtime dir and an exec of the helper before Pi (plus `env` when
`TMPDIR` is set). Measured on this PR (e2e run 37182721393, k3d + gVisor): back-to-back p50
4316 / p95 4544 ms (main 4381 / 4652: −1.5% / −2.3%), spaced p50 3767 / p95 4143 ms (main 3373 /
4309: +11.7% / −3.9%; 5 trials, its p50 swings by that much between runs on main too). Within
10% on both p95s and the 20-trial p50; milestone "connected → Pi ready" ≈ 1.9 s in both.

## For KOBE-41 (which guarantees now hold)

With Pi identities (every Kobe pod):

- **Another thread's tools cannot write, read or list a Pi's runtime dir** (EACCES): no planted
  `settings.json`/`models.json`/`SYSTEM.md`/`bin/`, no rewritten `model.json`, and they cannot
  read that Pi's token or run id. The KOBE-41 audit's cross-thread attacks (plant while Pi boots,
  plant around a model switch, rewrite the model file) are now impossible, not just detected.
- **Nobody but the agent can write `model.json`**, including the Pi's own tools (it is the
  agent's file in the agent's directory).
- **No other process can ptrace or signal a Pi**: other identities by uid; its own tools because
  Pi is their ancestor (Yama scope 1, enforced by gVisor, measured).
- **What remains is the Pi's own tools writing its `agent/` dir** (Pi 1.0.0 must be able to write
  there). The tripwire keeps checking that, and it remains a detector there, not a boundary: an
  informed tool of the same thread can still plant `models.json` around a model switch of its own
  Pi. That only changes its own thread's behaviour, which the attacker controls already.

## For KOBE-42: can `x-kobe-run-id` be trusted for per-run budget stops?

**Not yet for hard stops; it is now trustworthy for attribution between threads.**

- Now true: a Pi's model calls carry the run id the agent wrote for that Pi, and no other thread
  can change it (model file read-only to everyone but the agent, unreadable to other identities;
  no ptrace/signals across identities).
- Still true: a run's own tools run as that run's Pi identity and can read its `model.json`, which
  holds the sandbox's `kobe.model-gateway` token. With it they can call the gateway directly with
  any run id leased to the sandbox, or none (the shim accepts calls without the header). And
  code planted in the shared /workspace (D13) can run under another thread's identity when that
  thread executes it. So a per-run stop keyed on the header can be dodged by a prompt-injected
  run.
- Therefore KOBE-42 should keep enforcing hard limits at the sandbox (token), user (virtual key)
  and team levels, and use the run id for attribution and soft per-run stops (`run.stop
after_step` driven by Pi-reported usage). Making it enforcement-grade needs a credential the
  run's tools cannot use for other runs: a **server-minted per-run model token** (a `run` claim
  the gateway reads instead of the header), delivered to that Pi only — not as a file its tools
  can read, e.g. over an inherited socket like the policy channel. Proposed as a follow-up ticket
  (it changes `run.start` and the gateway, i.e. contracts).

## For other tickets

- **KOBE-22/25 (pod spec)**: keep `supplementalGroups`, the capability pair, `allowPrivilegeEscalation:
true`, `KOBE_PI_RUNAS`, `KOBE_PI_RUNTIME_DIR` and the `pi-runtime` memory volume; never mount the
  bootstrap token outside `/run/kobe-agent`. The admission policy refuses any other capability.
- **KOBE-27 (sync)**: the agent reads the workspace through the group: files a tool makes
  owner-only (`chmod 600`, `ssh-keygen` keys) are **not synced**; the agent warns once per path
  and never treats them as deleted. Everything else syncs as before.
- **KOBE-39/62 (egress, MCP for tools)**: credentials meant for tools (an egress proxy token in
  `HTTPS_PROXY`) reach a Pi through its allow-listed environment and are readable by that Pi's
  tools; anything the agent keeps (the wire token) must stay in agent memory or under
  `/run/kobe-agent`.
- **KOBE-36 (policy channel)**: fd 3 is inherited through the helper unchanged; a tool cannot
  reach another thread's channel, and cannot ptrace its own Pi.

## Residual risks (flag for the security review)

1. **Shared /workspace, $HOME and /tmp (D13)**: a thread can plant code there (a shadowing
   `numpy.py` in /workspace, `~/.local/.../usercustomize.py`, a git hook) that another thread's
   tools later run under that thread's identity, which can then do what that thread's tools can
   (write its Pi's `agent/` dir, read its model file). Not deterministic (the other thread has to
   run it), but not prevented. Closing it needs per-thread workspaces/homes, against D13.
2. **The model-gateway token is readable by each run's own tools** (KOBE-42 above).
3. **The Pi's own tools can write its `agent/` dir** (KOBE-41 above; tripwire).
4. **Session files** (`/workspace/.kobe/sessions`, group-writable as before): any thread's tools
   can rewrite another thread's Pi session file (its conversation as Pi resumes it). Same as
   /workspace (1); the server's record is Postgres, mirrored entries are untrusted.
5. **Denial of service among the user's own threads**: a tool can fill the 64 MiB runtime volume,
   or make the agent remove/chmod its own entries elsewhere by name through a swapped workspace
   parent; `/tmp` files can be renamed by any identity. Runs fail visibly (`runtime_tampered`,
   `pi_unavailable`), nothing is read or written across threads.
6. **Capabilities in the pod**: `allowPrivilegeEscalation: true` + `SETUID/SETGID` in the bounding
   set. Only `kobe-runas` can use them (only file with capabilities, agent-only); a bug in it, or a
   compromised agent, can become any Pi identity (not root: the uid range is compiled in). Inside
   gVisor/Kata only.
7. **Agent compromise** is unchanged in scope: the agent was already the trust anchor.

## Shared files touched

`charts/kobe/templates/sandbox-admission.yaml`, `charts/kobe/tests/sandbox.test.ts`,
`services/server/src/sandbox/{constants,manifests}.ts` (+ tests), `images/sandbox/Dockerfile`,
`images/sandbox/test-image.sh`, `e2e/run.sh`, `.github/workflows/ci.yml`, `docs/install.md`.
No `packages/protocol` change, no migration, no new dependency.
