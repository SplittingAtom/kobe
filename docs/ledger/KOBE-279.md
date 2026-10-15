# KOBE-279: Mid-thread model changes write no model_change entry on real Pi

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (PR #286)
- **Branch / worktree:** `kobe-279-model-change-entry` in `../Kobe-wt279`
- **Depends on:** KOBE-209 (markers), KOBE-217 (Regenerate with…)

## Plan

1. Reproduce with the real Pi 1.0.0 (`images/sandbox/pi`) before changing anything.
2. Tests first: a real-Pi test for ac-1/ac-2, and unit tests for the extension's check.
3. Make the smallest fix that keeps kobe-models' limits and token handling as they are.

## Decisions

1. **The cause differs from the first guess.** In Pi 1.0.0 the extension API `setModel` _does_
   append a `model_change` (`AgentSession.setModel` → `appendModelChange`). ac-1 on one branch,
   with no restart, already passed against real Pi. The gap is the **restart on a branch
   point**:
   - When `run.start` has `parent_entry_id`, the agent stops Pi, appends `kobe.branch` and starts
     a new Pi.
   - That Pi registers only the run's model (the kobe provider is built from the model file).
     So the resume can't restore the branch's model (`getBranchSelection`: latest `model_change`
     or answer), and Pi silently falls back to the one registered model, the run's. On an
     existing session that writes no entry (`sdk.js` appends one only for new sessions).
   - The `input` hook then sees `ctx.model` equal to the run's model and does nothing.
   - This matches gate1: the regenerate always restarts Pi, so its switch is never recorded. Any
     other restart, such as a run whose config changes the launch key, behaves the same.
   - **A second, nondeterministic gap** showed up under load (full suite, about 1 run in 3; the
     extension's input hook was instrumented to see it). Pi checks the auth of a provider
     registered by an extension asynchronously (`registerNativeProvider` → `void refresh()`).
     The resume reads that snapshot (`hasConfiguredAuth`) before the check has finished, so it
     sometimes starts Pi with **no model**. The hook then selects the run's model, which records a
     `model_change` even when the branch was already on that model (a spurious marker). Before
     this ticket the same race sometimes recorded the very switch that ac-2 is about, so the
     symptom varied.
2. **The fix has two small parts.**
   - **kobe-models' `input` hook** compares the run's model with the **branch's** model, as well
     as Pi's selection. `branchModel` mirrors Pi's `getBranchSelection` without virtual models;
     it reads `ctx.sessionManager.getBranch()`. When they differ, the hook calls `setModel` again
     and Pi records the switch. `input` runs before Pi stores the prompt, so the entry lands
     after `kobe.branch` and before the user message. Registration, limits (KOBE-259) and the run
     token (KOBE-118) are unchanged; the new check only stops the early return.
   - **The agent starts Pi with `--model kobe/<gateway model>`** for the run (or compaction)
     model, so Pi never resumes without a model.
     - `resolveCliModel` searches all registered models, not only those that passed the auth
       check, which makes it deterministic.
     - An existing session gets no entry from it, so a switch is recorded only by the hook.
     - `--model` stays **outside the launch key**, so a model change between runs still never
       restarts Pi. This is the reason KOBE-41 kept the model out of the arguments. The
       `agent.models.test.ts` assertion changes from "no `--model`" to "the run's model", and
       the old `kobe-models/index.ts` doc comment is accurate again.
   - **Why not an agent-side RPC `set_model`** (the coordinator's example): it needs the same
     branch check, which would mean parsing the session file plus a `get_state` round trip, and
     the KOBE-169 tripwire around another model-selecting command. After a restart Pi's
     selection already equals the run's model, so comparing with it would never fire.
3. **No entry when nothing changed.** A branch already on the run's model is left alone, and so
   is a branch that records no model yet (a new session's first prompt: Pi wrote the root
   `model_change` itself).
4. fake-pi is unchanged. It doesn't model resume-time restoration, which is why the bug was
   hidden. The real-Pi suite now covers it.

## Open questions (for Chris or the coordinator)

- gate1 showed the session's root `model_change` ("Model changed to …flash") above version 3 of
  the first message. The web places a root entry's marker on the first message under it, so on
  root versions it reads as a change. Should the root (session setup) `model_change` be hidden?
  That would be web-only and separate from this fix.
- ac-3 (gate1 browser check) is for the coordinator after deploy.

## Evidence (acceptance criteria → test or command output)

- **Reproduced first:** without the fix, `kobe-models.model-change.real-pi.test.ts` ac-2 fails
  three runs out of three. The new branch is `kobe.branch → user two → assistant claude`, with no
  `model_change`. With the fix it passes three out of three.
- **ac-1** `services/sandbox-agent/src/kobe-models.model-change.real-pi.test.ts` › "a run on
  another model records the switch before its prompt; the same model records none".
- **ac-2** same file › "a branch on another model records the switch on the new branch, after its
  marker": `kobe.branch → model_change anthropic → user → assistant anthropic`. The old branch is
  untouched. A second branch on the branch's own model records none.
- Unit: `src/kobe-models/branch-model.test.ts` (`branchModel`, and the hook re-selects only when
  the branch is on another model).
- Launch: `src/pi/pi-launch.test.ts` "starts Pi on the run's model with kobe-models, outside the
  launch key"; `src/agent.models.test.ts` (argv names `kobe/openai/gpt-fake`).
- Full sandbox-agent suite with real Pi installed, three times in a row: 90 files passed
  (8 skipped). Before `--model`, the ac-2 "same model records none" step failed about 1 run in 3
  under that load (the startup race). `pnpm verify` green.
