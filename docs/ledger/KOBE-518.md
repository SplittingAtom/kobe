# KOBE-518: Drop the Pi 1.0.x allowance in the server version gate once no 1.0 sandbox remains

- **Status:** done on `group-hardening-3` (commits fdb953b2, 341cf84a)
- **Branch / worktree:** `group-hardening-3` in `../Kobe-g-hardening-3` (hardening lane 3)
- **Depends on:** KOBE-511 (Pi 1.4.0 pinned), the gate1 deploy of main 533a9dfb (2026-10-30)

## Plan

Empty `PI_PREVIOUS_MINORS` (packages/protocol `pi-rpc.ts`) so a 1.0.x hello is refused with
`unsupported_version` like any other minor; keep the mechanism for the next Pi upgrade.

## Decisions

- Keep the allowance list and the hello gate's warning rather than deleting them: the next Pi minor
  bump needs the same transition. `supportedPiVersion` / `admitPiVersion` take the list as an optional
  parameter (default `PI_PREVIOUS_MINORS`) so the upgrade path stays unit-tested while the list is
  empty. The warning now tells the operator when to empty the list again.
- Precondition checked on gate1 before the change: every team's SandboxTemplate and warm-pool pod is
  on `kobe-sandbox:local-533a9dfbc944` (Pi 1.4.0); the server logged no "previous Pi minor" warning
  since that deploy; a live owner run completed (coordinator check, docs/RUN-LEDGER.md 2026-10-30).

## Open questions (for Chris or the coordinator)

- None.

## Evidence (acceptance criteria → test or command output)

- `services/server/src/sandbox-wire/pi-version.test.ts`: "refuses 1.0.x now that the allowance is
  gone (KOBE-518)", "refuses a 1.0.x hello without logging (KOBE-518)", "accepts a previous minor
  only while an upgrade names it", "during an upgrade, accepts a named previous minor and logs a
  warning naming the sandbox"; `PI_PREVIOUS_MINORS` asserted empty.
- `vitest run src/sandbox-wire` in @kobe/server: 9 files, 68 tests passed (2026-10-30).
