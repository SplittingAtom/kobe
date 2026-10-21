# KOBE-464: Notebooks: live Python kernel in the sandbox, run route and run_cell tool

- **Status:** in review (group branch `group-18-notebooks`, not pushed)
- **Branch / worktree:** `group-18-notebooks` in `../Kobe-wt464`
- **Depends on:** KOBE-462 (file editor save path, merged in #339). Web: KOBE-465.
- **Spec:** [docs/specs/notebooks.md](../specs/notebooks.md) (NB1–NB16)

## Plan

1. Migration (own commit): `runs.kind` `notebook`; `sandbox_commands.kind` `notebook.execute`,
   `notebook.interrupt`, `notebook.restart` (`0169_notebook_kinds`).
2. Spec, then protocol: `notebooks.ts` (outputs, events, REST, `run_python`),
   `sandbox-wire/notebook-frames.ts`, capability `notebooks`, error code `kernel_unavailable`.
3. Sandbox image: ipykernel/jupyter_client/nbformat (hash-locked, debugpy excluded), the bridge
   `images/sandbox/kernel/kobe-kernel-bridge.py`, `test-image.sh` checks.
4. kobe-sandbox-agent: `src/notebook/` (bridge session, kernel manager, caps, launcher),
   `run_python` (kobe-tools) and its broker.
5. Server: `src/notebooks/` (ipynb, files, execution, user run), wire intake and `notebook.run`,
   routes, sweeper.

## Decisions (beyond the spec's binding ones)

- **A member's execution is a run** (`kind = notebook`, shape of a compaction): reuses the event
  stream, the one-active-run lock and the sweeper (lost requester → `start_lost`). Cost: no cell
  run while the agent runs in that thread (`thread_busy`); the kernel would serialise anyway.
- **The server orchestrates every execution**, the agent's too: `run_python` → `notebook.run` →
  the server resolves the code (cell / `.py` from the synced copy) and sends `notebook.execute`
  back on the same connection (an internal command, no row). One code path saves outputs; the
  kernel only ever runs code the server sent.
- **Outputs are read back from the run's events** for saving (NB11/NB14), never from the
  sandbox's answer; the holding replica drains the output appends before recording the answer.
- **Kernel transport:** bridge over stdio; ipykernel via jupyter_client `transport=ipc` in a 0700
  dir. ipykernel's IOPub "pipe" (a 127.0.0.1 TCP listener for forked children's output) is
  switched off by a launcher shim; the image test asserts zero TCP listeners. Kernel stdio is
  `/dev/null`, so nothing it writes can corrupt the bridge protocol.
- **Kernel identity:** each kernel takes its own Pi identity (pool of 16; Pi uses ≤ 8; kernels ≤ 4)
  and runs as its partner uid via `kobe-runas`; killed, reclaimed and released like a Pi identity.
  Its env is the tools' allow-list plus the egress variables (token file path, never the token).
- **No debugger:** debugpy excluded from the lock (`--unsafe-package debugpy`); ipykernel runs
  without it.
- **Caps:** 192 KiB per output, 200 outputs / 2 MiB per execution, stream text coalesced (100 ms,
  32 KiB), one marker on truncation; the server re-checks order and caps.
- **Saves are audited as the member** (`workspace.file_saved`), also for `run_python`.
- No new openapi entries (the file-edit routes set the precedent); the web chat stream ignores
  `notebook.*` until KOBE-465.

## Review fixes (Opus review, 2026-10-21)

- Eval isolation: `propose_file_edit` is eval-isolated; `run_python` with a path is denied in eval
  runs (code still runs in the eval sandbox's kernel); both wire handlers refuse eval connections.
- Stop on a notebook run sends `notebook.interrupt` (no `run.stop`); the kernel manager drops
  waiting executions on interrupt, run end, or a deadline counted from arrival.
- Kernel internet (Chris): through egress-proxy like the shell (NB17); blocked attempts of a
  member's notebook run land on that run.
- Accepted and recorded: `/code` rules don't see a file's code (as bash); user-site `.pth` files
  run at kernel start; forked children's prints not shown.

## Open questions (for Chris or the coordinator)

- Licence: `asttokens` 3.0.2 declares "Apache 2.0" (non-SPDX label): pending gate review.

## Evidence (acceptance criteria → test or command output)

- **ac-1** `docs/specs/notebooks.md` (NB1–NB16, §3 shapes for KOBE-465).
- **ac-2** `services/sandbox-agent/src/notebook/*.test.ts` (manager: start/reuse, order, interrupt,
  timeout → interrupt then stop, restart, died, LRU/busy cap, idle stop, caps, run ended),
  `agent.notebooks.test.ts` (wire), `launcher.test.ts` (real child, env allow-list, group kill).
  `images/sandbox/test-image.sh` on `kobe-sandbox:test-464` (compute2): 76/76 ok, incl. "a kernel
  runs 1+1 over the bridge, keeps state, draws PNG, opens no TCP port" and "as a partner uid
  through kobe-runas"; debugpy absent. Image removed afterwards.
- **ac-3** `services/server/src/notebooks.db.test.ts` (11): cell run streams and saves, `.py`
  saves nothing, conflict merge into current version, error codes, owner only, `thread_busy`,
  sandbox without capability → failed run, interrupt/restart/no_kernel, out-of-order outputs
  dropped, unknown command → lease violation (4007), sweeper fails a lost notebook run.
- **ac-4** same file, `run_python`: code run on the agent's run with text answer; notebook cell
  read from the synced copy and outputs saved; capability, policy verdict, input mismatch and
  single use enforced. `packages/db/src/notebook-kinds-upgrade.db.test.ts` for the migration.
- **verify:** format, lint, typecheck, unit tests, licence check, hygiene and wording pass; DB
  suites pass run directly (server 174 files / 2141 tests, db 89 / 1552, cli 37 with
  `KOBE_PG_BIN_DIR`; turbo does not pass that variable, so the cli backup tests fail inside
  `verify` on this Mac for want of `pg_dump`, unrelated to this ticket).
