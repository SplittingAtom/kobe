# KOBE-169: Interim fix: block the agent/models.json provider redirect

- **Status:** in review
- **Branch / worktree:** `kobe-169-models-json-interim` in `../Kobe-wt169` (based on KOBE-165, PR #126)
- **Depends on:** KOBE-165. Structural fix: KOBE-166/167/168 (paired tool uid).

## What Pi writes into `agent/` (verified, real Pi 1.0.0, also after `set_model`, `set_thinking_level`, prompts)

Only `auth.json`, `models-store.json` and their lock dirs. Never `models.json` or `settings.json`.
So option 1 (not writable by Pi's uid) cannot cover the whole dir (Pi needs the stores and locks),
but it covers exactly the two files that matter.

## Decision: option 1 on those two files, plus option 2 as the check everywhere

- The agent writes `models.json` (`{"providers":{}}`) and `settings.json` (`{}`) itself, read-only
  (0440 under a Pi identity, else 0400), before Pi starts (`models/agent-config.ts`). Real Pi runs
  fine with them (no write attempts, `set_model` ok).
- Under a Pi identity `agent/` is now 3770 (sticky): a tool (Pi's uid) cannot open the files for
  writing, nor rename or delete them to put its own in place. Kernel-enforced, so no TOCTOU window
  and no "plant removed again" case: nothing can be planted. Test: `identities.real.test.ts`.
- `set_model` is removed from the `pi.command` allow-list (protocol `pi-rpc.ts`; the server never
  sent it; an agent receiving it answers an error frame; test in `frames.test.ts` and the real-Pi
  agent test). Model choice per thread is `run.start`'s `config.model`.
- Everywhere (also without identities, where the tool has the agent's uid and can replace the
  files): every remaining `pi.command` (`#piCommand` in `threads/manager.ts`) is refused with
  `runtime_tampered` if `verifyRuntime()` finds the guarded files changed (content compare against
  what the agent wrote, no-follow open) or any unexpected entry, and checked again after Pi
  answered. On a hit that Pi is stopped and a warning is logged (`stopTampered`); the
  `command.result` error is what the server records. The pre-check closes case 3 (plant gone again
  before the next prompt): the plant is found at `set_model`, before Pi reads it.
- Placeholders also move the existing tripwire: a planted `settings.json`/`models.json` is now a
  content mismatch instead of an "unexpected entry".

## KOBE-165 cases

Through the agent all three pass (set_model is refused at the wire, and the plant is caught by the next command or run) (`kobe-models.redirect-agent.real-pi.test.ts`). The raw-Pi
`it.fails` cases stay red on purpose (no agent in between; Pi itself is unchanged): sentinel until
KOBE-167. A normal `set_model` still works (real Pi test and fake-Pi test).

## Residual risk

- Without a Pi identity (tool = agent uid) the check is detection with a window: a plant that lands
  after the pre-check and is removed before the post-check/next prompt is not seen. Production
  runs with identities (KOBE-71), where the lock is kernel-level; the paired uid (KOBE-167) is the
  structural answer.
- A future `pi.command` that selects a model from Pi's catalog must not be added to the allow-list.
- `identities.real.test.ts` additions run only in the Linux CI step (not run locally on macOS).
