# KOBE-235: KOBE-228 follow-ups: tool HOME without egress, kobe-pi dir squatting, ~ in Pi file tools

- **Status:** PR open
- **Branch / worktree:** `kobe-235-sandbox-home-followups` in `../Kobe-wt235`
- **Depends on:** KOBE-228, KOBE-244 (#213 review). Executor off only.

## Decisions

1. **HOME/TMPDIR without egress.** `egress-env.sh` already switched HOME/TMPDIR outside its egress
   block; the gap was that `BASH_ENV` was only set with egress. The agent now takes `toolEnvScript`
   (`egress.envScript` when wired, else the same root-owned file checked at start, `index.ts`;
   missing or unsafe: warn and leave tools on Pi's HOME, as in development) and sets `BASH_ENV` for
   every Pi without the executor. Test: `agent.egress.test.ts` ("without egress").
2. **Squatted `kobe-pi-<name>`.** The name was derived from the runtime dir's basename and the
   scratch base is sticky and writable by tools. `preparePiPrivateDirs` now makes its own
   `kobe-pi-<128 random bits>` with a plain `mkdir` and retries (8 times) with a fresh name on
   `EEXIST`, never reusing a directory it did not create. The `runtimeDir` argument is gone. Tests:
   `exec-wiring.test.ts`; real helper: `identities.real.test.ts` (tool-owned squat survives, ours is agent-owned).
3. **`~` in Pi's file tools: documented, not mapped.** Pi's read/write/edit expand `~` in Pi against
   its private HOME, which is deleted with the Pi. Mapping it to the shared home would mean making
   Pi's HOME the shared one (Pi loads `~/.node_modules` from it: the KOBE-228 hole) or patching Pi,
   which has no hook for it without the executor. With the executor, `KOBE_EXEC_TOOL_HOME` already
   maps it. Bash tools use the shared home. Comment in `thread.ts` and `egress-env.sh`; the real fix is KOBE-168.
4. **Atomic temp files.** New `src/atomic-file.ts`: temp files open with `O_CREAT|O_EXCL|O_NOFOLLOW|O_NONBLOCK`
   under a random `<name>.<16 hex>.tmp`, `fstat` must say regular file, mode set with `fchmod`.
   Used by the MCP (`mcp-token`, `mcp.json`: the fixed `.tmp` name is gone), model, egress and memory
   writers, workspace `writeFileAtomic`, session restore and skill extraction. The tripwire
   (`unexpectedEntries`) accepts the MCP random temps. Tests: `atomic-file.test.ts`,
   `pi-mcp-config.test.ts`, `runtime-dir.test.ts`; real helper: `identities.real.test.ts`
   (FIFOs and links planted by a tool at fixed and exact temp paths).

## Evidence

- ac-1: tests named above; real-helper cases run in CI's "Sandbox privilege separation" step
  (`scripts/test-identities.sh`), not on this Mac.
