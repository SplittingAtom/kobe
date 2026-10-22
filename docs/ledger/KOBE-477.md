# KOBE-477: Notebook Start button (wake the sandbox, start the kernel)

- **Status:** in review (group branch `group-27-notebook-start`, not pushed)
- **Spec:** docs/specs/notebooks.md NB19

## Design

- **Route:** `POST /v1/threads/{id}/notebook/start` (owner only; `notebooks/kernel-start.ts`). Not
  connected: wake, 202 `{status: "waking", retry_after_ms: 2000}` (the context viewer's pattern,
  with its per-replica memory of refused wakes → 409 `sandbox_refused`). Connected: 200
  `{status: "idle" | "busy"}`. No run, no event, thread never busied.
- **Command:** `notebook.restart` with `op: "start"` (no new kind, **no migration**). Agent
  `KernelManager.start`: starts the kernel if none, keeps a live one, arms the idle timer. New hello
  capability `notebook_start`; delivery refuses the op to agents without it
  (`kernel_start_unsupported` → 409 `notebooks_unsupported`).
- **Web:** `useKernel` phase (`unknown`/`waking`/`starting`/`running`/`stopped`); Start shows
  "Starting kernel…" on the first ask, "Waking sandbox…" after a 202 (polls, gives up after 5 min),
  then "Kernel idle"; disabled while working; Restart replaces it once a kernel is known up (started
  or a cell ran here); back to Start after Restart / `no_kernel`. Readers see no Start.

## Tests

- protocol `notebooks.test.ts`; agent `manager.test.ts`, `agent.notebooks.test.ts`; server
  `notebook-start.db.test.ts` (6); web `notebook-view.test.tsx`, `lib/notebooks/api.test.ts`;
  browser `e2e/browser/tests/notebook.spec.ts` Start step (first cell then counts `[1]`).

## Deploy

Needs the new sandbox image for Start (older agents answer `notebooks_unsupported`; Run still works).
