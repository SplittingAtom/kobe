# KOBE-470: Context viewer — the last model call's context from the sandbox (server + sandbox-agent + protocol)

- **Status:** in review (not pushed; group branch `group-20-context-viewer`)
- **Branch / worktree:** `group-20-context-viewer` in `../Kobe-wt470`
- **Depends on:** PR #341 (migration 0169 notebook kinds) — not merged when this was written; see
  Migration below. Web viewer: a follow-up ticket.

## Plan

1. Migration first: `thread.context` in `sandbox_commands_kind` (+ `commandTimeoutMs`).
2. Protocol: `context-viewer.ts` (route shapes, errors), `sandbox-wire/context-frames.ts` (frame,
   capability `thread_context`).
3. Sandbox: kobe-models records each call's context (`kobe-models/context-capture.ts`); the agent
   answers `thread.context` from it, else from the session file (`src/context/`).
4. Server: router `threadContext` + `wake`, delivery (capability, session sync first), route
   `GET /v1/threads/{id}/context` (`routes/thread-context.ts`).

## Decisions

- Spec: `docs/specs/context-viewer.md` (CV1–CV9). Chris's decisions are CV1, CV2.
- Exactness: capture at the Pi provider (kobe-models), which gets the very context Pi sends the
  adapter, verified against real Pi 1.0.0 (`context-viewer.real-pi.test.ts`): a leading system
  message with sections `preamble/tools/rules/docs/addendum/cwd` and `toolsAdded`, then messages.
  Summaries are skipped (`cacheRetention: "none"`).
- Capture lives in Pi's private `agent/` dir (tripwire allows `kobe-context.json` + its temp
  files), 0640, removed with the process. Fallback after a restart: replay the session file.
- Tokens: chars/4 (+1200 per image), scaled by largest remainder to input+cacheRead+cacheWrite of
  the call's answer (= the gauge's number). Window from kobe-models' model (catalog limit).
- Wake: the route answers 202 `waking` (and starts a wake via the new `router.wake`) when the
  sandbox is not connected, instead of holding the request through a wake; the web polls.
- Owner only: shared readers 403 `not_owner` (they can see the thread exists), others 404.
- Nothing stored: no audit, logs carry codes only, `no-store`. Review: the answer is sealed to a
  per-request X25519 key (HKDF-SHA256, AES-256-GCM; `@kobe/protocol/node` sealed-reply.ts), so
  the `sandbox_commands` row holds ciphertext only; unread context rows are swept after 60 s.
- Review 2: skill-eval threads 409 `context_unsupported` before any wake; refused wakes are
  409 `sandbox_refused` (at once, or on the next read within 2 min); the session fallback reads
  only the file's last 16 MiB (streamed) and adds `older_history` to `missing` when cut.
- Review: `exact`/`missing` on the answer (false + memory/project/viewed file/window for
  `session`); route in the OpenAPI document (`openapi/context.ts`).
- Rate limit 30/min per member (each read is a sandbox command).

## Open questions (for Chris or the coordinator)

- `session` source has no context window; the web can use the gauge's.

## Migration

- `0170_thread_context_command.sql` (generated), rebased onto main after PR #341 (0169 notebook
  kinds): its CHECK lists the notebook kinds and `thread.context`; `commandTimeoutMs` lists every
  kind (the upgrade test's marker `'thread.context'` stays valid).

## Evidence (acceptance criteria → test or command output)

- ac-1: `docs/specs/context-viewer.md`.
- ac-2: `services/sandbox-agent/src/context/*.test.ts` (sections, split prompt, scaling = usage
  total, caps), `kobe-models/context-capture.test.ts`, `kobe-models/provider.test.ts`
  (onCallEnded), `agent.context.test.ts` (none / session / capture through the agent),
  `context-viewer.real-pi.test.ts` (real Pi 1.0.0 + real gateway shim: sections, sum = total).
- ac-3: `services/server/src/thread-context.db.test.ts` (row holds no plaintext marker, via a
  test trigger; unread row purged; owner 200 + no-store + no rows left;
  shared reader 403, others 404; 202 waking; older agent 409; busy 409; failure/invalid 502;
  session sync before the command).
- ac-4: `packages/protocol/src/context-viewer.ts`, `context-viewer.test.ts`.
- Migration: `packages/db/src/thread-context-command-upgrade.db.test.ts`.
- Sealing: `packages/protocol/src/node/sealed-reply.test.ts` (round trip, other key/thread,
  tamper, one use).
- Full-run failures are not caused by this change: `tools.pi-parity` reads a fake-tool log shared
  between its grep and find cases (runs locally only now that Pi is installed; passes alone);
  model-gateway is untouched and its virtual-key sync test is timing-bound (passes alone).
- `pnpm verify` (2026-10-21): format, lint, typecheck green; `test` green except, under full-run
  load with Pi installed locally, `kobe-exec/tools.pi-parity` (passes alone) and one flaky
  model-gateway test (passes alone); `test:db` green except the known cli backup tests (no local
  pg_dump bin dir).
