# KOBE-439: MA-7 `ui/message` and model context (web, server, protocol)

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

## HANDOFF for MA-6 and MA-8 (2026-10-19, written for a fresh agent)

**Branch** `group-ma-apps` in worktree `../Kobe-ma`, built on G10 (`group-10-connectors`
c2d7f110, PR #317, not yet on main). MA-1..5, MA-9 and MA-7 (KOBE-433..439) are built and
reviewed (review fixes included); **nothing is pushed and Hadron is untouched.** Next: MA-6
KOBE-440 (rail launcher and app cards), then MA-8 KOBE-441 (the Kobe Explorer Gate). Read the spec
`docs/specs/mcp-apps-host.md` (amended for MA4, T3, T11, MA10 and §8) and the ledgers
`KOBE-433.md` .. `KOBE-439.md`; reviews are in the session scratchpad (`review-ma*.md`).

**Migrations (one release, none shipped):** 0152-0156 site-wide templates and pins (MA-1..3);
0157 `thread_app_results` (generated, team table), 0158 RLS + legal-hold guards + run key
`ON DELETE SET NULL (run_id)` (custom), 0159 `input jsonb` (generated), 0160 run-end discard of
unclaimed results (custom trigger), 0161 the same with the hold lock first (custom); MA-6 added 0162 (generated, queued app cards). **Next free: 0163.**

**Protocol commits (each meant for its own PR, ahead of the feature PR; the coordinator decides
against the one-PR-per-group rule):** `92f6279c` (`tool.result.app`), `32a4ad26`
(`app_context`), `daa1470f` (`APP_CONTEXT_PREAMBLE`), `74d5bf70` (`splitAppContext`,
`imitatesAppContext`). MA-6 adds the `app_card` thread entry (protocol first).

**Decisions in force (do not re-open):**

- Frames: Kobe frame routes with header CSP `sandbox allow-scripts … webrtc 'block'`, the
  WebRTC guard script first, `sandbox="allow-scripts"`, never `srcdoc`. Kobe's own bridge (not
  ext-apps `AppBridge`; ext-apps is a web devDependency for the interop test only).
- App calls: MA-4 endpoints only, browser principal, read-only, audited; one validation per
  member; 3 live frames per thread (expanded tabs count); teardown on every removal.
- Capture: a signed ticket on the allow; the proxy reports `{ticket, input, result}`; claimed
  only when exactly one unclaimed row matches (run, Pi tool, input digest), else text; unclaimed
  rows dropped at run end; ≤ 20 per run; the store locks the run row.
- Context: chips sent only with the member's message; fenced, escaped, compact JSON; refused if
  imitated; stripped from titles, cards, follow-ups and eval copies. `ui/message` never moves
  the focus and is not sendable until edited or confirmed. Unsent chips are lost on reload (ok).

**Open questions:**

- ~~Pi 1.0.x `custom_message` shape~~: verified in MA-6 (KOBE-440.md, real Pi test).
- LOW-D (review-ma7): a proxy report that times out but commits late can, for two identical
  parallel calls, let one call claim the other's row. Same user, same input. Not fixed.
- Whether the protocol commits ship as separate PRs.

**What MA-8's gate must prove** (spec §11; add the fake MCP template and tools to
`e2e/lib/fake-mcp.js` and the spec to the k3d browser list with `KOBE_REQUIRE_APP=1`):

1. **Real Pi passes MCP arguments unchanged**: the claim digests Pi's `tool.call` input against
   the proxy's canonical input. Call a UI tool whose schema has a **default** and a **coercible
   argument** (`"5"` for an integer) and assert the card gets the `app` marker. A mismatch fails
   safe (text) but would make every card text.
2. **ac-1 frame isolation** on k3d and gate1: `e2e/browser/tests/app-frame.spec.ts` (fetch, XHR,
   WebSocket, img, form, window.open, top navigation, cookie, storage, parent DOM, WebRTC, the
   header-only frame), with `KOBE_ALL_BROWSERS=1` in the Playwright container to measure
   Firefox's WebRTC.
3. **The Catalyst Explorer flow** on gate1 (spec §11 b): pin `ui://catalyst/lakehouse-explorer`,
   approve it, "Open the lakehouse explorer" → the card shows the tree; select a table → chip;
   "Use in chat" inserts `` Use table `c.n.t` `` with the "From" marker, no focus move; confirm and
   send → the fenced block is in the run's input; reload rebuilds; Expand and back; then MA-6's
   rail launch.
4. The negative checks of §11 (fetch out, open-link, write tool, forged result, drift → text, no
   key → text and no rail app, no key in the network log, export text only).

Group MCP Apps (`group-ma-apps`), after KOBE-438. Spec `docs/specs/mcp-apps-host.md` §8, MA7, T8.
Nothing pushed; Hadron untouched.

## Commits

- `32a4ad26` protocol: `submitMessageBodySchema.app_context` (`app-context.ts`): 1 to 3 parts,
  one per app, each `{connector_id, app_id, template_sha256, data: {content?,
structuredContent?}}` of at most 8 KiB. `daa1470f` protocol: `APP_CONTEXT_PREAMBLE` (shared by
  server and chat). **Both are their own commits, for their own PR** (docs/parallel-work.md).
- `f4dedb54`, `8cb87909` server; `09e0eaa6` web; then the export test, ledger and spec.

## Design

- **No new storage.** The context is part of the run's input: the server writes one fixed
  sentence (`APP_CONTEXT_PREAMBLE`), then per part
  `<app-context source="connector:<name>" untrusted="true">` + JSON (with `<`, `>`, `&`
  escaped, so data cannot close the fence) + `</app-context>`, then a blank line and the member's
  text (`apps/context-block.ts` `withAppContext`). Pi's user entry is that input, so the thread's
  history, replays, forks and exports carry exactly what was sent (spec §8 "stored in the user's
  thread entry"). Schedules never carry it (only `trigger: user`).
- **Server check** (`runs/orchestrator.ts` `submitMessage`): each part must name an app the
  member can open now (`memberApps`: MA8, their own credential), of that connector, with the
  same approved template hash; else 422 `app_context_invalid` ("An app's context can no longer
  be sent. Remove its chip and try again."). The connector's name comes from the server, never
  the client.
- **`ui/message`** (`lib/apps/app-context.ts` `ComposerInsertChannel`,
  `components/apps/use-app-composer.ts`, `components/chat/composer.tsx` `useAppInserts`): the
  text goes in at the caret of the composer on screen (the card's own thread: frames run only for
  visible cards), which takes the focus and flashes (`data-app-insert`); never sent; 4 KiB of
  UTF-8 (the bridge and the channel). No composer (read-only, Trash): the app gets
  `{isError: true}`.
- **`ui/update-model-context`** (`AppContextStore` on the chat session): one chip per app per
  thread draft (last write wins), 8 KiB or the app gets `-32602`;
  `components/apps/app-context-chips.tsx` shows "Context from _app_: _one line_", the exact JSON
  in a disclosure, and a remove button. The runtime's send and the composer's queue path send
  `appContextBody(chips shown)` and clear them on success; a failed send keeps them.
- **History** (`components/chat/messages.tsx` `PlainText` + `splitAppContext`): a user message
  that starts with the preamble shows its blocks as "Context from _connector_ (untrusted data)"
  chips (JSON in a disclosure) above the member's own text.
- OpenAPI regenerated (`SubmitMessageBody.app_context`).

## Acceptance criteria

- **ac-1** never sends, own thread: web `app-context.test.tsx` "puts ui/message text into this
  thread's composer and never sends it" (no POST); `app-context.test.ts` (channel: latest
  composer only, 4 KiB).
- **ac-2** visible, removable, only what it shows is sent: web "shows a removable chip and sends
  exactly the chips shown" (last write wins, body = the chip, cleared after) and "sends nothing of
  a chip the member removed".
- **ac-3** fenced and untrusted, in history and exports: server `app-context.db.test.ts` (run
  input and the sandbox's `run.start` message are exactly the preamble + block + text),
  `context-block.test.ts` (cannot close the fence or forge the attribute),
  `export-markdown.test.ts` (the block in the Markdown export), web history test.
- **ac-4** sizes: protocol `app-context.test.ts` (8 KiB per part, 3 parts, one per app); server
  400 over 8 KiB; web store refuses over 8 KiB; `ui/message` 4 KiB.

## Review fixes (review-ma7: MEDIUM-2, MEDIUM-3, LOW-A..C, E, F, H, I), `b5c3c81a..`

- MEDIUM-2: `ui/message` never moves the focus; a "From _app_" marker blocks Enter and Send
  until the member edits or confirms (web tests: Enter in the app frame sends nothing).
- MEDIUM-3: `memberText` strips context from first message, last exchange, title fallback and
  eval copies (DB test: the thread card shows only the member's text).
- LOW-A/B: the store locks the run row (cap tested with 25 parallel reports); LOW-C: 0161.
- LOW-E: imitation refused (server 422 `invalid_content`, web channel); queued edits keep the
  block. LOW-F: compact JSON, 413 `message_too_large`. LOW-H: channel keyed by thread. LOW-I:
  invisible and bidi characters escaped in the fence and dropped from chip summaries.

## Notes for review

- The chips live in the browser tab (session) per thread draft: a reload drops unsent chips,
  as it drops other draft state that is not the text. Spec §8 says "after the send the chip
  clears"; it does not say chips survive a reload.
- Steering a running run (`POST /v1/runs/:id/steer`) does not carry chips; Enter during a run
  queues a message, which does.

## Re-review LOWs (review-ma7 re-review: LOW-J, K, L, M), `71291a5f`, `938f0547`

- LOW-J: an insert's gate lifts only on Confirm, an emptied composer, or a change of the
  inserted text itself at least 800 ms after the insert (`settlesInsert`); typing around it
  does not. LOW-L: the gate lives in `ComposerDictationProvider` (`useInsertGate`), so the
  steer chord, the `steer` command and Steer now are unavailable while an insert waits.
- LOW-K: `runActive` locks `FOR NO KEY UPDATE` (DB test: a store does not wait on a held
  `FOR KEY SHARE`). LOW-M: steer refuses imitated app context (422 `invalid_content`).
- LOW-D stays accepted (spec MA10: same run, tool, canonical input and member).
