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
4. **ac-4** Agent work goes through one gate: `IsolationGate.require()` returns the verified
   RuntimeClass name (the one sandboxes must use) or throws `IsolationRuntimeMissingError`
   (code `isolation_runtime_missing`, HTTP 503) — what chat returns.
5. **ac-5** Without isolation the server keeps serving (auth, admin) so the admin console can show
   the fix: `GET /v1/install/isolation` (install Owner/Admin) returns state + remediation;
   `POST /v1/install/isolation/check` re-checks now.
6. **ac-6** `/readyz` reports the isolation state; it is not ready only until the first check
   completes, so a ready pod always knows its isolation state.
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
  while the first check is pending.
- `KOBE_RUNTIME_CLASS` is optional in config (unset ⇒ gate is permanently "missing" with a clear
  message) so the server still serves the admin console; a malformed value fails fast.
- Re-check interval 60 s (status, logs, readiness); `require()` always re-checks live (deduplicated
  with any in-flight check), so there is no cached-verdict window and no wall-clock dependence
  (review MEDIUM 3). Kubernetes API call timeout 10 s. Losing
  isolation refuses new agent work; tearing down running sandboxes is the orchestrator's call
  (KOBE-22) — it can read `status()`.
- Agent-running code (KOBE-22/30/64) must call `isolation.require()` and use the returned
  `runtimeClassName` for sandbox pods; the gate is the only source of that name.

## Open questions (for Chris or the coordinator)

- Removing the server's isolation initContainer (see Decisions) reverses part of KOBE-6; it is
  what D4's "admin console shows the fix" needs, but flag for Chris.
- Residual window: `require()` verifies live, but a cluster admin could swap the RuntimeClass
  between that check and pod creation. KOBE-22 should call `require()` immediately before creating
  each sandbox and use the returned name; an admission policy would close it fully (out of scope).

## Evidence (acceptance criteria → test or command output)

| AC    | Evidence                                                                                                                                                                                              |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ac-1  | `gate.test.ts` "verifies the configured RuntimeClass by its handler", "refuses a class named like gVisor…"; e2e `server verified the gVisor RuntimeClass in process`; Chris's k3s: `gvisor` → `runsc` |
| ac-2  | `gate.test.ts` "re-checks live before agent work…", "disables agents when the RuntimeClass disappears after boot, and recovers"                                                                       |
| ac-3  | `gate.test.ts` unset env / API error / API hang / throwing clock / throwing listener cases; chart test "cannot be disabled"                                                                           |
| ac-4  | `gate.test.ts` "returns the verified RuntimeClass…", "throws isolation_runtime_missing (HTTP 503)…"                                                                                                   |
| ac-5  | `install-isolation.test.ts` (admin-only GET/POST, verified/missing/checking bodies, POST re-checks)                                                                                                   |
| ac-6  | `app.isolation.test.ts` (503 while checking; 200 + state when verified or missing)                                                                                                                    |
| ac-7  | `gate.test.ts` one `onChange` per transition; `index.ts` logs error+fix / info                                                                                                                        |
| ac-8  | `config.test.ts` RuntimeClass cases                                                                                                                                                                   |
| chart | `render.test.ts`: scheduler preflight initContainer kept; server only `wait-for-migrations`, RBAC + env                                                                                               |
| all   | `pnpm build test typecheck lint format:check` green locally (except known Helm 4 chart lint); code review: 0 CRITICAL/HIGH, MEDIUM 1–3 fixed                                                          |
