# KOBE-232: G4a: e2e/gate4.sh — user stories U1–U16 end to end on k3d and on the real cluster

- **Status:** in progress (group G5, branch `group-5-gates`; not pushed)
- **Branch / worktree:** `group-5-gates` in `../Kobe-g5`
- **Depends on:** KOBE-231 (Gate 3 harness, same branch)

## Plan

`e2e/gate4.sh`: one verdict per story from **parts** (sections of the gate runs' output). Parts
already proven by Gates 1–3 come from their own runs, unchanged; the rest is
`e2e/gate4/stories.sh` (U1, U2 memory, U5, U6, U7, U8 Orbit, U11 80 %, U14, U15 search, U16 chart).
Client in a server pod: `e2e/gate4/client.mjs` + `connectors.mjs` after the Gate 1–3 helpers.
Docs: `docs/gates/gate-4.md`.

## Decisions

- **No re-runs in CI.** Shards gate1, gate2, gate3 keep their output as artifacts; a new shard
  `gate4` runs only `stories.sh`; a new job `stories` (no cluster) runs
  `KOBE_GATE4_VERDICT_ONLY=1 e2e/gate4.sh` on the logs, and `k3d` requires it. On a real cluster
  `e2e/gate4.sh` runs Gates 1–3 (without Gate 1's cold-start trials) and the stories itself, each
  once. Gate 1–3 sections a story uses are named in `PARTS` in `e2e/gate4.sh`.
- **A part passes** with ≥ 1 `ok` and no `FAIL`/`INVALID`/`XPASS`/`NOTRUN`; a missing section (a run
  that stopped early, or a step that was skipped) fails the story. `NOTRUN` marks a part this
  environment cannot run (e.g. 2FA enforcement on a shared install); the story is then not proven.
- **U7 fake server:** `e2e/lib/fake-oauth-mcp.js`, a JS port of the server tests'
  `fake-oauth-server.ts` plus an MCP endpoint; each authorization gets its own subject so the call
  shows whose token the proxy attached. Tokens for the scan are opened from Kobe's sealed store in a
  server pod (works for any server), then the full Gate 2 scan runs over both sandboxes
  (`scan.sh` gained `SCAN_LABEL` and a per-user directory).
- **U7 real server:** Linear's remote MCP (OAuth 2.1 + DCR), Notion's as fallback; consent by a
  person in the browser or by `KOBE_GATE4_MCP_AUTHORIZE_CMD_M1/_M2`. Drift always uses the fake.
- **U8 eval gate:** blocks deterministically with the Orbit image's own test model
  (`images/orbit-eval/testing/fake_model_server.py`, model `fake-vulnerable`) as catalog alias
  `orbitvuln`; the `kobe-orbit-eval` image is now built in e2e (archive `e2e-extra-*`, loaded only
  by the gate4 shard; `e2e/load-images.sh` checks `KOBE_E2E_EXTRA_IMAGES`).
- **Time travel in Postgres:** U6 moves an approval's expiry to now (after reading its 1 h TTL),
  U14 pulls a schedule forward (as KOBE-181's e2e). U1 writes `site_settings.require_2fa` back
  because the Owner, without TOTP, is held once 2FA is required.
- **U1 passkey** via a software WebAuthn authenticator (port of the server tests' one) against
  Better Auth's real endpoints; the invitation link is read from Mailpit (a busybox probe pod).
- Shared helpers moved to `e2e/lib/gate-turns.sh` (turn, prompts, json_str); gate3 now prints a
  `==> project:` header before its project setup (so U10 owns those checks).

## Product failures found

- None new yet (runs pending). KOBE-420 (no "vN available" badge or switch) showed as `XFAIL U8`;
  fixed on this branch, so U8's gate3 browser part is ordinary checks again.

## Open questions (for Chris or the coordinator)

- Real-cluster run needs: a quiet gate1, two accounts on the chosen OAuth MCP server, and consent
  to `KOBE_GATE4_TOTP_REQUIRE=1` (holds users without TOTP for seconds) and
  `KOBE_GATE4_RUNC_CLASS=1` (a cluster-scoped RuntimeClass, deleted after).
- The gate4 shard's time on hosted runners is unmeasured (estimate 15–20 min after the install;
  the Orbit eval Job and U7's drift wait are the long parts).

## Evidence (acceptance criteria → test or command output)

- ac-1 (U1–U16, one selectable check per story, passes in CI): pending the group CI run (`stories`
  job). U16's restore part is KOBE-233's `e2e/gate4-restore.sh` (shard `restore`, same branch).
- ac-2 (real cluster): command in docs/gates/gate-4.md "Running it"; not run (needs the go-ahead).
- ac-3 (each story names its criteria; nothing weakened): the verdict prints each story's spec text
  and its parts; product failures stay as checks (XFAIL with the filed ticket).
- Local: `bash -n`, shellcheck (warning level) clean for the new files; actionlint clean; the fake
  OAuth server's DCR → authorize → token → call → drift path run locally; the verdict logic run on
  synthetic logs (ok, FAIL, XFAIL, missing section, strict mode).
