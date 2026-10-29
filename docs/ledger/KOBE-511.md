# KOBE-511: Pi 1.0.0 -> 1.4.0 in the sandbox image

- **Status:** done locally (worktree `../Kobe-g-hardening-2`, branch `group-hardening-2`; not pushed)
- **Pin:** `@earendil-works/pi-coding-agent` 1.4.0 (latest; no 1.4.x patch yet), lockfile regenerated
  with `npm install --package-lock-only --ignore-scripts`; `brace-expansion` resolves to 5.0.12.

## Changelog 1.0.1-1.4.0 mapped (only items touching the areas below; the rest is TUI, providers, codemode)

Source: CHANGELOG.md in the 1.4.0 tarball; docs/rpc.md, json.md, extensions.md and dist diffed 1.0.0 vs 1.4.0.

| Ver   | Item                                                                                                                           | Area              | Kobe                                                                                                                       |
| ----- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 1.0.1 | `brace-expansion` 5.0.12 pinned direct (GHSA-q2hr-2g5m-vwhr, -qhr7-859c-m2p7, -6j4f-fj2g-mc7p)                                 | brace/shell       | fixed by the bump (lock has 5.0.12 only)                                                                                   |
| 1.0.1 | `npm-shrinkwrap.json` removed from the package                                                                                 | install           | our lockfile now pins the whole tree itself; `npm ci` unchanged                                                            |
| 1.0.1 | `@earendil-works/chord` dependency removed; `pi-telemetry` added                                                               | deps              | licence report refreshed (all MIT)                                                                                         |
| 1.0.1 | `pi.registerToolRenderer()` added                                                                                              | extension API     | n/a (additive; Kobe draws in the web app)                                                                                  |
| 1.0.1 | Removed experimental server/client (`pi-server`, `pi-client`, `pi-protocol`)                                                   | RPC               | n/a: Kobe never used `pi-server` (D13); RPC mode unchanged                                                                 |
| 1.0.3 | **Breaking:** provider `azure-openai-responses` renamed `azure`                                                                | config            | n/a: Kobe registers only its own `kobe` provider                                                                           |
| 1.0.3 | Truncated-output files readable by the user only                                                                               | tools             | n/a                                                                                                                        |
| 1.0.4 | `--tools` keeps MCP tools; `*` patterns; `--no-mcp`                                                                            | CLI               | n/a: Kobe passes no `--tools`                                                                                              |
| 1.0.4 | System prompt rules leave out tools hidden by `prepareLoadout` (`hiddenTools`)                                                 | prompt sections   | n/a: section names unchanged (test pins them)                                                                              |
| 1.1.0 | `agent_settled` gains `aborted`; `tool_execution_end` gains `durationMs`                                                       | RPC events        | n/a: loose schemas pass fields through (`pi-events.ts`)                                                                    |
| 1.1.0 | `+name`/`-name` in `--tools`                                                                                                   | CLI               | n/a                                                                                                                        |
| 1.1.0 | Standalone binaries no longer load `.env` from cwd                                                                             | env               | n/a (npm install, not the binary)                                                                                          |
| 1.1.0 | RPC `bash` output colour fragments fixed                                                                                       | RPC               | n/a: server never sends RPC `bash`; kobe-exec routes it                                                                    |
| 1.2.0 | **Breaking:** `before_agent_start` also fires for `pi.sendMessage(..., {triggerTurn})` runs; event is a union on `messageType` | extension API     | n/a: kobe-tools reads only `systemPrompt` (both variants carry it) and Kobe never calls `sendMessage`; test pins the field |
| 1.2.0 | **Breaking:** session busy while a run starts; `sendUserMessage()` needs `deliverAs`                                           | extension API     | n/a: no Kobe extension calls either                                                                                        |
| 1.2.0 | **Breaking:** theme schema URL moved; `pi mcp list --json` reports `resources: true`                                           | config/CLI        | n/a (`--no-themes`; no `pi mcp list`)                                                                                      |
| 1.2.0 | `reachesTools` on tool definitions; namespace `aliases`                                                                        | tool registration | n/a (optional fields)                                                                                                      |
| 1.2.0 | `before_agent_start` sections no longer dropped after the first tool call (cache)                                              | prompt            | n/a (improves kobe-tools memory prompt caching)                                                                            |
| 1.2.0 | `~` expanded in settings path entries                                                                                          | config            | n/a (`--no-*` lockdown, explicit `-e`)                                                                                     |
| 1.3.0 | Resume restores the session's active tools                                                                                     | tool registration | n/a: memory tools are re-synced on every `input`; real-Pi suites green                                                     |
| 1.3.0 | Tool calls with malformed JSON args now fail validation                                                                        | tools             | n/a (policy sees only valid calls)                                                                                         |
| 1.4.0 | Extension tools never added/removed by the branch are active unless `defaultActive: false`                                     | tool registration | already set for ls/grep/find in kobe-exec; test pins `defaultActive`                                                       |
| 1.4.0 | `grep` runs `rg --no-config`                                                                                                   | brace/shell       | **changed:** kobe-exec's routed grep passes `--no-config` too (parity)                                                     |
| 1.4.0 | `before_provider_headers` no longer sees attribution headers; User-Agent from pi-ai                                            | provider          | n/a: kobe-models sets its own headers in `auth`                                                                            |
| 1.4.0 | Summaries use the model's output limit (`reserveTokens` ignored)                                                               | compaction        | n/a: kobe-models compact suites green                                                                                      |
| 1.4.0 | `@earendil-works/pi-ai/models` exposed to extensions                                                                           | extension API     | n/a (kobe-models imports the root, aliased to `pi-ai/compat`)                                                              |
| 1.4.0 | `PI_CODEMODE_MAX_WORKERS`                                                                                                      | env               | n/a (not in the allow-listed env)                                                                                          |
| all   | Node engines `>=22.19.0`                                                                                                       | Node              | image has Node 22.23.4                                                                                                     |

Not in the changelog but found: **the server refused any Pi outside 1.0.x** (`supportedPiVersion`,
`PI_PINNED_VERSION`) and `test-image.sh` / `e2e/run.sh` asserted 1.0.x. Changed: `PI_PINNED_VERSION`
1.4.0 plus `PI_PREVIOUS_MINORS = ["1.0"]`, so sandboxes created from the previous image keep
connecting until their template moves (needs review: drop "1.0" once no 1.0 sandbox remains).
Slash commands: same list; `/share` text changed (web mapping updated, `PI_VERSION` 1.4.0).
Read tool gained `outputSchema`/`structuredContent`; kobe-exec uses Pi's own `execute`, so parity holds.

## What changed

- `images/sandbox/pi/package.json` + lock: 1.4.0. Dockerfile comment, `test-image.sh` (pi is 1.4.x),
  `e2e/run.sh` (wait/check 1.4.x, scripted hellos 1.4.0), sandbox-image workflow step name.
- `packages/protocol` `pi-rpc.ts`: `PI_PINNED_VERSION` 1.4.0, `PI_PREVIOUS_MINORS`; server
  `supportedPiVersion` accepts both; `fake-sandbox` hellos with the pinned version.
- `services/sandbox-agent/src/kobe-exec/search.ts`: `rg --no-config`.
- New `services/sandbox-agent/src/pi/pi-extension-api.real-pi.test.ts`: pins `VERIFIED_PI`
  (fails on any bump until updated), loads kobe-exec, kobe-tools (all four memory hooks),
  kobe-policy and kobe-models through Pi's real `loadExtensionFromFactory`, checks ExtensionAPI
  methods, event names (`on(event: ...)` overloads), event/result fields Kobe reads,
  `pi-ai/compat` exports and loader alias, tool factory arity, and system-prompt section names
  round-tripped through `splitRenderedPrompt`. In CI it throws if Pi is not installed.
- New `services/server/src/sandbox-wire/pi-version.test.ts`.
- Licences: `images/sandbox/third-party-licenses.json` from `collect-licenses.sh` on the built image,
  `THIRD_PARTY_LICENSES.md` regenerated, inventory/licensing Pi row 1.4.0 (LICENSE at v1.4.0 is MIT).
  38 npm packages added, 39 removed, all MIT/Apache/BSD; no new exception.
- `.github/dependabot.yml`: Pi in its own npm entry.

## Dependabot: why Pi got no PRs

`/images/sandbox/pi` was listed (`directories: ["/", "/images/sandbox/pi"]`, since 2026-10-09), so
the directory was not missing. The entry has one `open-pull-requests-limit: 10`, and the root's npm
bumps filled it at each run: 10 root PRs opened 2026-10-09, 10 still open now (#172, #294, #296-298,
#300-304), no npm PR at all on 2026-10-23, and never one for Pi although 1.0.1+ existed on every
run. Fix: Pi has its own npm entry (limit 5). The new surface test makes such a PR fail until reviewed.

## Evidence

- `services/sandbox-agent` full suite with real Pi 1.4.0: local 134 files passed / 7 skipped;
  `CI=1` (built dist extensions, executor built): 136 passed / 5 skipped (1146 tests). Skipped are
  the root/Linux-uid suites (identities, exec.real, projects.readonly, kobe-models.redirect helper).
  `agent.real-pi.test.ts` and every `*.real-pi.test.ts` ran.
- New surface test: 10/10. Server unit suite 197 files / 2423 passed (incl. `pi-version.test.ts`);
  server DB suite (dev Postgres) 197 files / 2381 passed; protocol 1085/1085; web `lib/shell` 111/111.
- Image built on the remote amd64 Docker host (`kobe-sandbox:kobe-511`, tag removed after):
  `test-image.sh` 77 ok, 0 fail. `collect-licenses.sh` + licence CLI: 311 packages passed;
  `pnpm license:check` passed. Trivy not run locally (CI `sandbox-image` runs it).
- Typecheck/lint: sandbox-agent, server clean.

## Open / follow-ups

- `npm audit` (pre-existing in 1.0.0): Pi pins `undici` 8.10.2 (high: 8 advisories, fixed in 8.12.2+).
  Not overridden here; candidate follow-up (npm `overrides` now possible without the shrinkwrap).
- `pi-ai/compat` is marked temporary upstream; the surface test fails when it goes.
- CLAUDE.md still says "Pi pinned 1.0.0" / "Pi `1.0.x`" (not edited by the agent; coordinator to update).
- Executor and suite e2e shards run in CI only (k3d); not run locally.
