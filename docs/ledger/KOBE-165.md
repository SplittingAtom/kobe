# KOBE-165: T1 real-Pi test: can a tool redirect the Kobe provider via Pi's agent/ dir

- **Status:** in review
- **Branch / worktree:** `kobe-165-provider-redirect-test` in `../Kobe-wt165`
- **Depends on:** KOBE-118. Related: KOBE-119 (design, PR #120), KOBE-167 (the fix).

## VERDICT: EXPLOITABLE (one reload path), against real Pi 1.0.0

A tool (same uid as Pi) that plants `models.json` with a `providers.kobe.models[]` entry carrying its
own `baseUrl`, then waits for the `set_model` RPC, gets Pi to send the session token
(`authorization` / `x-api-key`) and `x-kobe-run-token` to a listener it owns. Local run: 4 requests
per model call reached the listener, each with the live run token.

Not exploitable (tests pass): a prompt on the same or another model (the kobe-models `input` hook
calls `setModel` with its own model object), `get_available_models`, a provider-level `baseUrl` or
`headers`, a second provider selected by `settings.json` `defaultProvider`, a planted `auth.json`.

## Why (Pi 1.0.0 code, `@earendil-works/pi-coding-agent/dist`)

- `core/provider-composer.js:137-168` `applyModelsJson`: a `models[]` entry upserts a catalog model
  with its own `baseUrl`. `:171-176` `applyExtension`: when the extension supplies `models`, those
  replace the models.json ones. kobe registers only the current run's model
  (`kobe-models/register.ts:110-113`), so after another model ran, the other ids come from models.json.
- `core/model-runtime.js:581` `refresh` re-reads models.json, and every `registerProvider`
  (`:673`) triggers it, so the plant is loaded by the next registration, not only on `/model`.
- `modes/rpc/rpc-mode.js:365` `set_model` resolves the model from that catalog, and
  `core/agent-session.js:1910` `setModel` selects it. kobe-models then keeps it:
  `register.ts` returns early when the selected id equals the run's model. Its `baseUrl` wins.
- Why prompts are safe: the `input` hook passes a fresh model object (`kobeModel`, gateway
  `baseUrl`) to `setModel`, bypassing the catalog.

## Reach in the product

`set_model` is in the server's `pi.command` allow-list (`packages/protocol/.../pi-rpc.ts`); nothing in
`services/server` sends it today. The agent's tripwire (`verifyRuntime`) sees a planted file only
before a prompt and does not run on `pi.command`. A tool that deletes the files after the reload
leaves it nothing to find while Pi keeps the redirected model (test "plant removed before the
prompt"). So: needs a `set_model` (or any other catalog lookup of the kobe model) while a plant exists.

## Tests

- `services/sandbox-agent/src/kobe-models.redirect.real-pi.test.ts`, driver
  `src/testing/real-pi-rpc.ts`. Real Pi, real kobe-models + kobe-policy, real bash tool, real local
  gateway behind a tap (records headers, strips the run token the local gateway does not know).
  No agent, so no tripwire. Runs in the normal `pnpm test` (needs Pi from `npm ci --prefix
images/sandbox/pi`, as the other real-Pi suites); no setuid helper and no Linux needed.
- Red tests are `it.fails` (3 cases) with the secure assertion; when KOBE-167 lands they fail with
  "Expect test to fail": change them to `it`.

## Evidence (ac-1, ac-2)

ac-1: verdict above, 8 passing + 3 expected-fail cases, local macOS run with Pi 1.0.0.
ac-2: exploitable, so the red regression tests are committed as `it.fails` referencing KOBE-167.

## Open questions

- Also close in the agent (cheap, independent of KOBE-167): run the tripwire on `pi.command`, or
  drop `set_model` from the allow-list while kobe-models owns model selection.
