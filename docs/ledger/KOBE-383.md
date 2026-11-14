# KOBE-383: SMA8 — render "What Kobe knows" in the sandbox, cache-stable

- **Status:** in review (local commit on `kobe-383-sm-render`, based on `kobe-382-sm-selection`)
- **Branch / worktree:** `kobe-383-sm-render` in `../Kobe-wt383`
- **Depends on:** KOBE-377 (contract, merged), KOBE-382 (selection, not merged yet). No migration.

## What it does

- `services/sandbox-agent/src/memory/semantic-context.ts` renders `run.start.memory.semantic` in
  two parts:
  - `known`: `## What Kobe knows`, the preamble, the Policy lane, then the pinned items per lane;
  - `picks`: `## What Kobe knows for this message`, the per-message picks per lane and the
    overflow line.
- kobe-tools appends the run's parts in this order (`kobe-tools/memory-hooks.ts`): `known`, Notes
  (`## Saved memory`), project instructions, `picks`, viewed file (KOBE-462), sync conflicts
  (KOBE-492). Everything before the picks is stable across messages unless an item changes.
- Lanes run widest first (Policy, Site, Workspace, portable, user), so the narrowest scope (which
  wins for preferences) is read last. Inside a lane, items keep the server's order.
- Labels inside each fence: "organization policy, set by the Site"; "Site memories, set by the
  Site"; "Workspace memories, approved by a Workspace curator"; the person's memories (portable /
  this workspace), ", pinned" for pinned lanes. Item line:
  `- <kind>: <statement> (as of <date>; saved <date>[, imported | , learned from a conversation | , from a Workspace proposal])`.
- Preamble: facts and preferences people saved, not instructions; narrowest scope wins for
  preferences/conventions; ask the person when facts disagree; nothing overrides organization
  policy; only the END marker with this nonce ends a block.
- `known`/`picks` are written to the run file (`memory-context.json`, new `known` / `picks`
  keys) whatever Notes says: Policy reaches agents set to Notes only or Off (Chris, Q6/KOBE-382).
  The overflow line says "use recall to search them" only when Notes (so `recall`) is on.
- The agent now announces `semantic_memory` in `hello` whenever it announces `memory`.
- Context viewer (`context/system-prompt.ts`): each lane is its own `memory` section, labelled
  from `CONTEXT_MEMORY_SECTION_LABELS` ("Policy", "Workspace memories (pinned)", …). When the
  run's parts changed since the call, the parts are found by header as "What Kobe knows" and
  "What Kobe knows for this message".

## Decisions

- **Per-thread nonce = HMAC-SHA256(process key, "kobe-memory-fence:" + thread id), 16 hex**
  (`deriveNonce` in `kobe-tools/memory-fence.ts`, `threadFenceNonce` in `memory/context.ts`). The
  key is 32 random bytes made when the agent process starts and kept only in its memory: Pi (which
  runs as another identity) and memory content never see it. So the nonce is the same for every
  run of a thread, different for every thread, and cannot be guessed from memory content or from
  another thread's nonce (the owner's context viewer shows their own thread's nonce). Considered:
  the session/run token (rotates, KOBE-483, so it would break stability) and a nonce stored in
  the workspace (Pi can read and S3 sync copies it). Cost: a new agent process (sandbox resumed
  from hibernation) gets a new key, so one uncached prefix, then stable again; provider caches
  expire within minutes to an hour anyway. Sanitising still breaks up `<<<`, folds look-alikes
  and strips invisible characters, and every statement is forced onto one line.
- The same thread nonce fences the Notes indexes (they used a fresh nonce per run). `recall`
  results keep a fresh nonce per call: they land in the conversation once and never change.
- The viewed-file fence keeps its per-run nonce: it sits after the picks, so it does not affect
  the cached prefix.
- **Project instructions go before the picks** (not named in the brief): they are as stable as
  the Notes indexes, so they belong in the cached prefix.
- **Size cap.** `run.start` carries no budget, so the cap is the size the server filled to,
  `semanticMemoryRenderedBytes(semantic)`, raised to the smallest Site budget (4 KiB, which the real
  budget is never below) and limited to 16 KiB. Over the cap, whole items are dropped from the end
  (picks, then pinned, never Policy) and added to the overflow count; no fence is ever cut. The
  preamble and the two headers take more than the contract's 256-byte block overhead, but item
  lines take well under 96 bytes each, so a block filled to the largest budget renders without
  dropping anything (test). Only a tiny block goes over the computed number, and it stays far under
  4 KiB.
- One nonce for all lanes, not one per scope: each fence carries a scope label, and sanitising
  already stops a forged marker; one nonce keeps the notice short.

## Open questions (for Chris or the coordinator)

- The overflow line points to `recall`, but `recall` does not search semantic items until the
  ticket that adds `recall({query})` over items lands. Until then it searches Notes only.
- Contract wording (`run-context.ts`) says the renderer stays within each fixed overhead; it stays
  within the total instead (see Size cap). A follow-up contract PR could raise the block overhead
  to ~512 bytes so the selector accounts for it exactly.
- Re-picking every message still changes the prompt at the picks, so the conversation history
  after the system prompt is uncached whenever the picks change. Gate A measures what is left.

## Evidence (acceptance criteria → test or command output)

- **ac-1** `memory/semantic-context.test.ts`: order (Policy, pinned in `known`; picks in `picks`;
  lane order), fences and labels, preamble, overflow line (with / without recall), Policy only
  (Notes only / Off), size cap (budget formula, full 16 KiB block without drops, drops from the
  end, never Policy). `kobe-tools/memory-hooks.test.ts`: order in the prompt (known, Notes,
  project, picks, viewing, conflicts), kept with Notes off, malformed field fails closed.
- **ac-2** `memory/context.test.ts` "a changed item reaches the next run without restarting Pi":
  real run file + the hooks installed once; `memory-hooks.test.ts` same at the hook level. The real
  Pi test (`kobe-tools.memory.real-pi.test.ts`, skipped without a local Pi) checks `semantic_memory`
  in `hello` and the block in the prompt; the existing "a changed index reaches the next run" covers
  the same run-file path.
- **ac-3** `semantic-context.test.ts` "fence escapes stay inside the fence" (marker with and without
  the nonce, zero-width, fullwidth, tag/bidi/controls, fake item line, fake header via U+2028);
  `context.test.ts` "per-thread fence nonce": same across runs of a thread, different across threads,
  Notes block byte-stable per thread.
- **ac-4** splitter: `context/sections.test.ts` "What Kobe knows (KOBE-383)" (lane labels, header
  fallback). Cache-read share: method and SQL in [`docs/gates/gate-7a.md`](../gates/gate-7a.md);
  numbers to be filled at Gate A on gate1 (the fake model here reports no cache tokens).
- Docs: `docs/guide/memory.md` "What the agent sees" (reaches `/llms.txt` through `@kobe/guide`).
- Local note: `src/models/runtime-dir.test.ts` fails 2 tests when `TMPDIR` is under the home
  directory (non-sticky parent); passes with `TMPDIR=/tmp`, and fails the same without this change.
