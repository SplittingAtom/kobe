# KOBE-9: Server isolation startup check

- **Status:** in review (PR #10)
- **Branch / worktree:** `kobe-9-isolation-startup` in `../Kobe-wt9`
- **Depends on:** KOBE-6 (merged)

## Acceptance criteria (derived from spec D4, principle 7, U16; Hadron unreachable)

Spec D4: "A Helm pre-install hook and a server startup check verify a gVisor or Kata RuntimeClass.
Without one, Kobe refuses to run agents: the sandbox orchestrator stays disabled, chat returns
'isolation runtime missing,' and the admin console shows the fix. There is no 'no isolation' mode."

1. **ac-1** The server process verifies, in process at boot, that `KOBE_RUNTIME_CLASS` exists and
   has a gVisor (`runsc`) or Kata (`kata*`) handler — judged by handler, never name.
2. **ac-2** It re-verifies periodically and live before agent work; a RuntimeClass deleted or
   replaced after boot disables agents.
3. **ac-3** Fails closed: unset `KOBE_RUNTIME_CLASS`, API errors, timeouts or a pending first check
   never yield "verified". There is no bypass flag, value or env var.
4. **ac-4** Agent work goes through one gate: `IsolationGate.require()` runs a fresh check and
   returns a branded `VerifiedIsolation` (only `gate.ts` can create one) carrying the RuntimeClass
   sandboxes must use, or throws `IsolationRuntimeMissingError` (code `isolation_runtime_missing`,
   HTTP 503) — what chat returns.
5. **ac-5** Without isolation the server keeps serving (auth, admin) so the admin console can show
   the fix: `GET /v1/install/isolation` (install Owner/Admin) returns state + remediation;
   `POST /v1/install/isolation/check` re-checks now.
6. **ac-6** `/readyz` is binary and does not disclose the isolation state (unauthenticated); it
   is not ready only until the first check completes, so a ready pod always knows its state.
7. **ac-7** Operator-facing logs: error with remediation when isolation is missing/lost, info when
   verified/restored (on transitions only, no log spam).
8. **ac-8** Config: `KOBE_RUNTIME_CLASS` is validated with zod (malformed name fails fast).

## Plan

- `services/server/src/isolation/gate.ts` (+ test): stateful gate over the existing `checkIsolation`.
- `services/server/src/routes/install-isolation.ts` (+ test): admin status/re-check.
- `app.ts`: optional `isolation` option → `/readyz` state + one route line. `index.ts`: start/stop.
- Chart: server drops the `isolation-preflight` initContainer (the in-process gate replaces it, see
  Decisions); scheduler keeps it and gets `KOBE_RUNTIME_CLASS`. Render tests, e2e, install.md.

## Decisions

- **Server no longer blocks at pod start (initContainer removed from the server only).** D4 requires
  that without isolation "chat returns 'isolation runtime missing' and the admin console shows the
  fix" — impossible if the server pod never starts. The in-process gate is the server's startup
  check; the install-time `lookup`, the hook Job and the scheduler initContainer are unchanged.
- `/readyz` stays 200 when isolation is missing (so the admin console is reachable); it is 503 only
  while the first check is pending, and never reports the state (security review L2). e2e checks
  each server/scheduler pod's `isolation verified: agents enabled` log line instead.
- Handler pattern `^(runsc|kata(-[a-z0-9]+)*)$` (server and chart; a chart test keeps them equal)
  so multi-part Kata handlers like `kata-qemu-snp` pass (security review L3).
- `KOBE_RUNTIME_CLASS` is optional in config (unset ⇒ gate is permanently "missing" with a clear
  message) so the server still serves the admin console; a malformed value fails fast.
- Re-check interval 60 s (status, logs, readiness). `require()` always starts its own check and
  never joins one that began before the call (security review L1); an older-started check never
  overwrites a newer result. No cached-verdict window, no wall-clock dependence. Kubernetes API call timeout 10 s. Losing
  isolation refuses new agent work; tearing down running sandboxes is the orchestrator's call
  (KOBE-22) — it can read `status()`.
- `status()` and `config.runtimeClassName` are display-only and never valid for authorisation
  (documented on `status()` and `VerifiedIsolation`).

## Binding requirements for KOBE-22, KOBE-30, KOBE-64 (security review M2, L4)

1. Call `isolation.require()` **immediately before each sandbox/pod creation** (not once per run
   or per process) and pass the returned `VerifiedIsolation` into the code that builds the pod
   spec; use its `runtimeClassName`. Functions that create sandboxes or pods take a
   `VerifiedIsolation` parameter, never a raw RuntimeClass name string.
2. After the Sandbox/pod is created, read it back and verify `spec.runtimeClassName` equals the
   verified class and that class still has the verified handler; on any mismatch delete the
   sandbox and fail the run with `isolation_runtime_missing`.
3. Consider a ValidatingAdmissionPolicy in `kobe-team-*` namespaces that rejects pods whose
   `runtimeClassName` is not the verified class (closes the check-to-create window entirely).
4. Scheduler jobs (KOBE-64) that start agent runs go through the same `require()` path; the
   scheduler's initContainer is not a substitute.
5. Chat/run endpoints map `IsolationRuntimeMissingError` to HTTP 503 with
   `err.toResponseBody()` (no cluster details to non-admins).

## Open questions (for Chris or the coordinator)

- Removing the server's isolation initContainer (see Decisions) reverses part of KOBE-6; it is
  what D4's "admin console shows the fix" needs, but flag for Chris.
- Residual window between `require()` and pod creation: closed by the binding requirements
  above (KOBE-22), not in this ticket.

## Evidence (acceptance criteria → test or command output)

| AC    | Evidence                                                                                                                                                                                                                                                                                                                       |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ac-1  | `runtime-class.test.ts` handler cases (accepts `kata-qemu-snp`, `kata-clh-tdx`; rejects `kataX`, `Runsc`, `runsc `, `runsc2`, `kata-`); `gate.test.ts` "verifies the configured RuntimeClass by its handler", "refuses a class named like gVisor…"; e2e per-pod `isolation verified` log line; Chris's k3s: `gvisor` → `runsc` |
| ac-2  | `gate.test.ts` "re-checks live before agent work…", "disables agents when the RuntimeClass disappears after boot, and recovers"                                                                                                                                                                                                |
| ac-3  | `gate.test.ts` unset env / API error / API hang / throwing clock / throwing listener cases; chart test "cannot be disabled"                                                                                                                                                                                                    |
| ac-4  | `gate.test.ts` "returns the verified RuntimeClass…", "throws isolation_runtime_missing (HTTP 503)…", "VerifiedIsolation cannot be forged" (nominal type via `@ts-expect-error`, private constructor, runtime guard, mint not exported), "starts its own check instead of joining one that began before the call"               |
| ac-5  | `install-isolation.test.ts` (admin-only GET/POST, verified/missing/checking bodies, POST re-checks)                                                                                                                                                                                                                            |
| ac-6  | `app.isolation.test.ts` (503 while checking; 200 when verified or missing, no state in the body)                                                                                                                                                                                                                               |
| ac-7  | `gate.test.ts` one `onChange` per transition; `index.ts` logs error+fix / info                                                                                                                                                                                                                                                 |
| ac-8  | `config.test.ts` RuntimeClass cases                                                                                                                                                                                                                                                                                            |
| chart | `render.test.ts`: scheduler preflight initContainer kept; server only `wait-for-migrations`, RBAC + env; handler regex identical to the server's                                                                                                                                                                               |
| all   | `pnpm build test typecheck lint format:check` green locally (except known Helm 4 chart lint); code review: 0 CRITICAL/HIGH, MEDIUM 1–3 fixed; security review M1, L1–L3 fixed, M2/L4 recorded above                                                                                                                            |
