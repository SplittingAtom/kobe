# KOBE-119: 74a: Spike: paired tool uid per thread, design decision

- **Status:** in review
- **Branch / worktree:** `kobe-119-paired-uid-spike` in `../Kobe-wt119`
- **Depends on:** KOBE-71, KOBE-118, KOBE-123 (read only). Migrations: none. Doc only.

## Plan

Read the KOBE-71/118/123 ledgers, `kobe-runas.c`, the sandbox Dockerfile, `pi-launch.ts`, and the
Pi 1.0.0 package (`npm pack`, scratch dir) for its tool seams. Write `docs/design/paired-tool-uid.md`.

## Decisions

- Recommend option B (executor process under a partner uid, Pi tools redirected by a root-owned `-e`
  extension through `registerTool` + `operations`); reject the helper-from-Pi option (needs Pi
  without `no_new_privs`) and seccomp/Landlock (cannot protect files).
- Main finding: the run token is not readable from Pi memory (Yama), but a tool can write Pi's
  `agent/` dir (`models.json`), so it may be able to make Pi send the token elsewhere. Unverified;
  proposed first ticket is a real-Pi test.

## Open questions (for Chris or the coordinator)

- Memory cost of one executor per Pi; whether the T1 test gates the rest.

## Evidence

- No cluster or container experiment (no local Docker engine); runsc claims cite the KOBE-71
  measurements and are marked where not re-checked.
