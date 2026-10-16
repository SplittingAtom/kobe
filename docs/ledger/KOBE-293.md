# KOBE-293: Context gauge keeps the pre-compaction size after Compact now

- **Status:** committed on `group-3-phase-c-org` (ticket group G3, Phase C; no PR of its own)
- **Branch / worktree:** `group-3-phase-c-org` in `../Kobe-g3`
- **Depends on:** KOBE-211 (gauge), KOBE-213 (Compact now), KOBE-288 (long prompts reconcile)

## Root cause

Not the offloaded prompt. The suspect (`compactedSinceLastCall` stopping at an offloaded message)
does not fire in this scenario: the stream's body-less copy of the >64 KiB prompt (provisional seq
from 1e12) is replaced by the thread read KOBE-288 triggers, keyed by entry id. The server mirrors
Pi entries inline (`sandbox-wire/entries.ts` never sets `blob_ref`), so the stored prompt comes back
with its body and its real seq. After the compaction the entries are, in seq order: prompt 1,
answer 1, long prompt, answer "OK", compaction. `compactedSinceLastCall` returns true.

The stale value came from `state.live`: the ended run stays there with `contextTokens` from its
streamed answer (40.8k). `newestContextSize` dropped only the stored `run_usage` value when
compacted, then fell through to the streamed one. Before KOBE-288 the spec reloaded the page after
the long send, which cleared `live`; KOBE-288 removed that reload, which exposed it. Any run
streamed in the same tab before Compact now shows it, long prompt or not.

## Fix

`context-usage.ts` `newestContextSize`: `compacted` returns null first. Streamed messages are
entries too (merged in the same state update), so when the entries hold a compaction after every
call, the run on screen streamed nothing since.

## Tests

- `components/chat/compact-dialog.test.tsx` "the gauge after Compact now, once a run streamed in
  this tab (KOBE-293)": a >64 KiB prompt and a short prompt, each run streamed, then Compact now:
  no meter; the next run's call shows again. Both failed before the fix (meter at 40800).
- `lib/chat/context-usage.test.ts`: compacted with a streamed size is unknown.
- ac-2 (compact-now.spec.ts on gate1) is proven after G3 deploys; the spec is unchanged.
