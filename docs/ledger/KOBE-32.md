# KOBE-32: Web chat on assistant-ui ExternalStoreRuntime

- **Status:** in review
- **Branch / worktree:** `kobe-32-web-chat` in `../Kobe-wt32`
- **Depends on:** KOBE-30 (runs), KOBE-31 (event stream), KOBE-34 (thread API), KOBE-33 (search),
  KOBE-14 (team switcher), KOBE-20 (web structure, API client), KOBE-29 (entry tree) — all merged

## Acceptance criteria (derived from D14–D18, D23, §3.D, §4 U4/U5/U12/U15, §5.2, §5.3, §6.1, §6.2, Gate 1; Hadron unreachable)

1. **ac-1 Runtime (D16).** assistant-ui `ExternalStoreRuntime` fed by a Kobe store that projects
   `thread_entries` into a branchable message repository (`parentId` + `headId`), plus a
   `RemoteThreadListAdapter`.
2. **ac-2 Thread list.** List (newest first, Load more), search (`?q=`, KOBE-33, snippets as plain
   text), new thread, rename, Trash and restore (D18). Thread in the URL (`?thread=`).
3. **ac-3 Conversation.** The entry tree with the active branch (leaf), branch picker switching the
   leaf (`POST /leaf`), edit-and-regenerate and Regenerate branching via `parent_entry_id`.
4. **ac-4 Streaming with gapless resume (Gate 1, U4).** Kobe Event Stream per run; deltas bound to
   entries by `entry.committed`; refresh, reconnect and second device resume with no gap or
   duplicate; 204/410 fall back to the entries.
5. **ac-5 Queue, Steer, Stop (D17, U5).** Enter queues while running; queued messages shown,
   editable, deletable and run in order; Steer now; Stop (queued messages remain).
6. **ac-6 Interrupted (D14).** Interrupted state blocks the queue; Retry from last entry and
   Continue without retry; survives a reload; history intact.
7. **ac-7 Tools and notices.** Tool call/result cards; `policy.denied` shown clearly;
   `egress.blocked` (U12); waking (D14); failed/budget-stopped runs; slots for approvals (KOBE-37),
   artifacts (KOBE-55) and files (KOBE-54).
8. **ac-8 Errors.** 401/403/404/409 (`thread_busy`, `team_mismatch`, `no_active_team`)/503
   (`isolation_runtime_missing`, `isolation_unavailable`) rendered with the way out; a message the
   server refused goes back into the composer.
9. **ac-9 Accessibility and layout.** Keyboard (Enter/Shift+Enter/Ctrl+Shift+Enter, thread list
   arrow keys), skip link, labels, live region for run changes, `aria-busy` while streaming;
   responsive like the consoles (list folds below 48rem), light and dark.
10. **ac-10 Not an authorization boundary.** Every action through the server APIs with
    `X-Kobe-Team`; nothing fetched or cached on the Next.js server.

## Design

`apps/web/lib/chat/` (logic, no React) and `apps/web/components/chat/` (UI):

| Module                             | Role                                                                                           |
| ---------------------------------- | ---------------------------------------------------------------------------------------------- |
| `lib/chat/api.ts`                  | Thread/run resources over `apiRequest` (team header on every call, `Idempotency-Key` on sends) |
| `lib/chat/entries.ts`              | Defensive parsing of Pi session entries (untrusted agent output)                               |
| `lib/chat/tree.ts`                 | Entry tree + live run → assistant-ui messages, `headId`, entry ↔ message maps                  |
| `lib/chat/live.ts`                 | Pure reducer of a run's events (dedupe by seq, deltas, tools, notices, terminal)               |
| `lib/chat/stream.ts`               | EventSource per run, contract validation, batching, close/reconnect signals                    |
| `lib/chat/thread-state.ts`         | Thread state and its rules (active run, run to stream, live overlay)                           |
| `lib/chat/thread-controller.ts`    | One open thread: load, refresh, stream lifecycle, actions                                      |
| `lib/chat/session.ts`              | Per team: API + controllers held by views                                                      |
| `lib/chat/thread-list-adapter.ts`  | `RemoteThreadListAdapter` over the Thread API (Trash = archived)                               |
| `components/chat/kobe-runtime.tsx` | `useRemoteThreadListRuntime` + per-thread `useExternalStoreRuntime`                            |
| `components/chat/*`                | App shell, sidebar, thread view, messages, tool card, run panel, composer, `slots.tsx`         |

**Server (one read endpoint):** `GET /v1/threads/{id}/pending-messages` (`routes/thread-pending.ts`,
one mount line in `app.ts`, OpenAPI `openapi/pending.ts`, `thread-pending.db.test.ts`). Run
snapshots carry no message text, so without it the queue couldn't be shown or edited, and the prompt
of a run in progress would vanish on reload or on a second device until Pi commits it (U4).

## Decisions

1. **One assistant message per Pi turn.** A chain of assistant steps and tool results is one
   assistant-ui message (id = its first entry), ended where the tree branches; non-message entries
   (`model_change`, `compaction`, `branch_summary`, …) are hidden but keep their place (an edit of
   the first message branches from the `model_change` entry before it). Tool results attach to
   their tool-call part. The iterative projection handles 5,000-entry threads.
2. **Branch switch = `POST /leaf`** with the deepest entry of the chosen branch, optimistic, reverted
   with the server's error (e.g. 409 `thread_busy`). assistant-ui ignores switches while running.
3. **Edit and Regenerate send `parent_entry_id` = the edited user entry's parent** (the server's
   branch point, KOBE-30 retry semantics). **Root branching (Chris: supported, follow-up ticket):**
   editing the first message / regenerating the first answer needs a protocol + sandbox-agent +
   server change. Until then both actions are shown unavailable (`aria-disabled`, tooltip and
   description "coming soon"); `lib/chat/features.ts ROOT_BRANCHING_AVAILABLE` is the switch and
   `kobe-runtime.tsx branchAndSend` is where the root branch point goes.
4. **Streaming:** the client streams the active run, else the next queued run (to see it start:
   queued runs have a `run.queued` event and an open stream gets `run.started`). After a reload the
   stream starts at `starting_after=0` and replays the run from Postgres (the uncommitted deltas
   aren't anywhere else); events are applied in ~32 ms batches so a replay renders once. Dedupe by
   seq in the stream and in the reducer.
5. **EventSource hides statuses:** when the source closes before a terminal event (204/410/404/409),
   the client asks `GET /v1/runs/{id}`: ended → read the entries; still active → reopen (backoff,
   5 tries, then "Live updates stopped" with Reconnect). The terminal event closes the source
   client-side, so the browser doesn't make a pointless reconnect for the 204.
6. **Queue/Steer/Stop:** our own composer buttons over assistant-ui's `ComposerPrimitive` (no
   assistant-ui queue adapter: with one, every send — idle ones too — goes through a fire-and-forget
   `enqueue`, so a refused message couldn't be returned to the composer). Idle sends go through
   `onNew`, which throws `MessageNotSentError` on failure (draft restored); queued sends clear the
   composer only on success. Steer shortcut Ctrl/Cmd+Shift+Enter (assistant-ui's convention).
7. **Sends are idempotent:** one `Idempotency-Key` per message; a network error is retried once
   with the same key (the server answers with the first run).
8. **Stop pauses the queue (Chris's decision).** The server side lands with KOBE-26 (PR #43 has
   not implemented it yet), so the UI is built against the expected behaviour: after Stop the queue
   is held until the user resumes (`POST /v1/threads/{id}/queue/resume`) or sends a message. The
   client marks the queue paused on Stop (when messages are queued) and takes the server's
   `queue_paused` from `GET /v1/threads/{id}/runs` when present (expected field name; absent =
   client flag, cleared when a run starts or the queue empties). A held queue isn't streamed, so the
   stopped run's partial answer and "Stopped." stay on screen; the queue shows "Queue paused" with
   **Resume queue**. With today's server (next starts after Stop) the flag clears as soon as the
   next run is active (tested both ways in the fake server: `pauseOnStop`). **KOBE-26:** please
   expose `queue_paused` on ThreadRuns, keep `queue/resume` as the resume action, and release the
   queue on a new message.
9. **Tool activity** (`policy.denied`, `egress.blocked`, approvals, artifacts, files) comes from the
   stream of the run on screen; after a reload of an ended run a denial shows as the tool's error
   result (the toolResult entry), not as the policy card. Events of older runs are not re-read.
10. **New thread title** = first line of the first message (≤ 80 chars), set at creation
    (`POST /v1/threads {title}`); `generateTitle` returns an empty stream (no model titling yet). The
    list reloads once after the first message so the title appears.
11. **Agent text is sanitised Markdown (Chris: yes, now)** — `components/chat/markdown.tsx`,
    `react-markdown` 10 + `remark-gfm` 4 (MIT), no `rehype-raw`: raw HTML is shown as text (a
    remark step turns `html` nodes into text), links only for absolute http/https/mailto URLs with
    `target=_blank rel="noopener noreferrer nofollow"` (everything else is plain text, checked twice:
    `urlTransform` and the `a` component), **images are never loaded** — a safe image URL becomes a
    link "[Image: alt]", an unsafe one its alt text (no tracking pixels; CSP `img-src 'self' data:`
    agrees), GFM tables/lists/task lists, fenced code with a Copy button. User messages, reasoning
    and tool output stay plain text. Search snippets are text with `<mark>` highlights.
12. **Session by closure, not React context, in the runtime hook:** assistant-ui runs the per-thread
    `runtimeHook` in its own host; a test that remounted the app saw the previous session through
    `useContext` there. The hook is created per session (`threadRuntimeHookFor`).
13. **Casing:** entry `payload` added to `OPAQUE_KEYS` in `lib/api/casing.ts` (tool arguments such
    as `file_path` must not become `filePath`). Run events keep `@kobe/protocol` snake_case and are
    validated with `kobeEventSchema` (anything failing the contract is dropped).
14. **5xx messages shown:** `isolation_unavailable` (runs, D4), `sandbox_unavailable`,
    `search_timeout` join `isolation_runtime_missing` in `lib/api/client.ts`; `isolation_unavailable`
    renders the isolation way out.
15. **Pending-messages visibility:** the thread's (`findThread`); queued messages only for the owner
    (they are drafts), a reader of a shared thread gets the active run's prompt only. The reader
    case can't be exercised over HTTP until KOBE-57 creates projects (KOBE-57 must add that test).
16. **Dependency:** `@assistant-ui/react` 0.15.23 (MIT; pulls radix-ui, zustand, assistant-stream,
    safe-content-frame, assistant-cloud client — all MIT/Apache, license check green apart from the
    pre-existing local vitest entry).
17. **Security headers (coordinator review).** `proxy.ts` (Next 16 proxy) sets a per-request CSP
    with a nonce: `script-src 'self' 'nonce-…' 'strict-dynamic'` (+ `'unsafe-eval'` only under
    `next dev`), `style-src 'self' 'nonce-…'`, `style-src-attr 'unsafe-inline'` (style attributes
    only), `img-src 'self' data:`, `connect-src 'self'`, `object-src 'none'`, `base-uri 'self'`,
    `form-action 'self'`, `frame-ancestors 'none'` (`lib/security/csp.ts`). Pages render per
    request (`app/layout.tsx` awaits `connection()`; responses are `private, no-store`).
    `next.config.ts headers()` adds X-Frame-Options DENY, nosniff, Referrer-Policy
    strict-origin-when-cross-origin and a Permissions-Policy on every path. No
    `upgrade-insecure-requests` (plain-HTTP installs). zod's eval probe is switched off
    (`lib/security/zod-jitless.ts`, `jitless: true`) so the CSP reports nothing. KOBE-55 revisits
    `frame-src` for `srcdoc` artifacts.
    **Verified** (besides `lib/security/csp.test.ts`): `next build` + `next start`, then headless
    Chrome over CDP against a smoke server serving `/v1/*` from the fake Kobe with real SSE: all 11
    `<script>` tags and stylesheet links carry the response's nonce, no `style=` attributes in the
    HTML, no CSP issue or console error while loading a thread, sending, streaming and finishing
    (before `jitless`, one `kEvalViolation` from zod's probe), Markdown rendered, `<script>` text
    shown as text.
18. **Plain-HTTP origins:** idempotency keys fall back from `crypto.randomUUID` (secure contexts
    only) to `getRandomValues` (`lib/chat/keys.ts`); any exception in a send clears the "sending"
    state and offers the message back.
19. **Resume after reload in the same tab:** when every event so far is reflected in committed
    entries, the controller stores a small resume point per run in sessionStorage (seq, committed
    ids, tool activity without inputs, notices); a reload whose entries contain those ids resumes
    with `starting_after=<seq>` instead of 0. Another device (or a point the entries don't cover)
    replays from 0 (`lib/chat/resume.ts`).
20. **Bounded live state:** notices, blocked domains, artifacts and files keep at most 50 each
    (newest), deduplicated (egress by domain, artifacts by id+version, files by id); delta lookups
    search from the end and bound message ids are a record (O(1) per delta). "Live updates stopped"
    explains the per-person stream limit (`too_many_streams`, 16 per server) since EventSource
    can't see the 429.
21. **No browser e2e harness added.** Gate 1 evidence for the web is component tests over the real
    runtime adapter, API client, casing layer and stream code with a fake server
    (`lib/chat/testing/fake-kobe.ts`: real wire shapes, SSE resume semantics, D14/D17 rules).
    Playwright would need browsers on the self-hosted runners and a full stack; the server side of
    Gate 1 is covered by KOBE-30/31's DB suites. `e2e/run.sh` checks the new route and that `/`
    serves the chat.

## Review round (typescript-reviewer agent, before CI) — resolution

No CRITICAL. Fixed: **HIGH** a send that returned after the thread was left opened an EventSource
on a disposed controller (now `#open`, `#syncStream`, `send`, `load`, `refresh`, `reconnect` stop
when disposed). **MEDIUM** a refresh read before a branch switch no longer reverts the chosen leaf
(`#leafVersion`); a leaf that isn't shown falls back to its nearest shown ancestor, never another
branch; failed entry pages / runs / pending reads are shown (partial history notice) and a failed
runs read doesn't (re)open streams; a run the server keeps refusing keeps its reopen backoff;
Regenerate hidden on the first turn (nothing to branch from); queued messages owner-only in the new
endpoint; repeated announcements re-announced (`announcementSeq`); a second Enter while a send is
in flight is ignored. **LOW** completed runs drop leftover live text; `load` merges with what the
stream delivered; refresh coalescing can't lose a call; no `Math.max(...spread)`; "Try again" after
a failed load. Kept: a seeded controller that is never mounted lives until the session ends; a
stale `?thread=` after a team switch (switching teams reloads the page).

## Coordinator security review (APPROVE with changes) and Chris's answers — resolution

1. CSP + security headers → decision 17 (`lib/security/csp.test.ts`, browser verification).
2. Plain-HTTP `randomUUID` → decision 18 (`lib/chat/keys.test.ts`; `thread-controller.test.ts`
   "sends on a plain-HTTP origin … and recovers from any send failure").
3. Caps/dedupe, O(1) deltas, resume points, `too_many_streams` text → decisions 19–20
   (`live.test.ts` "dedupes … at most 50", `resume.test.ts`, `conversation.test.tsx` "a reload in
   the same tab resumes after what the entries hold").
4. Markdown → decision 11 (`components/chat/markdown.test.tsx`: GFM, 19 hostile inputs inert,
   raw HTML shown as text, safe links, no images, code copy).
5. Stop pauses the queue → decision 8 (`conversation.test.tsx`: "Stop pauses the queue and keeps
   the partial answer; Resume queue runs the held messages", "with a server that doesn't hold the
   queue (KOBE-30) …", "sending while the queue is paused releases it").
6. Root branching → decision 3 (`conversation.test.tsx` edit test asserts the disabled first Edit
   with its description; Regenerate test asserts the disabled first Regenerate).

## For other tickets

- **KOBE-37 (approvals):** replace `ApprovalSlot` in `components/chat/slots.tsx` (it receives the
  tool's `approval.requested`/`approval.resolved`); post `POST /v1/approvals/{id}` from it. The tool
  card shows "Waiting for approval" already.
- **KOBE-55 (artifacts):** replace `ArtifactSlot` (on a tool card, or as a run notice when there's
  no `tool_call_id`); open assistant-ui's artifact panel from it.
- **KOBE-54 (files):** replace `FileSlot` with the download card.
- **KOBE-56 (memory):** `NoticeSlot` → `memory.updated` (add Undo there).
- **KOBE-39 (request access):** `EgressBlocked` (slots.tsx) gets the "Request access" action when
  `request_access` is true.
- **KOBE-53 (uploads):** add an attachments adapter to `useExternalStoreRuntime` and send `file_ids`
  in `lib/chat/api.ts sendMessage`.
- **KOBE-57 (projects):** pending-messages already follows `findThread`; read-only threads get 403
  `read_only` on every change, rendered as is.
- **KOBE-26:** Retry/Continue UI is here; nothing to add for the browser.

## Open questions (for Chris or the coordinator)

Answered by Chris (2026-10-03): Markdown now (decision 11); Stop pauses the queue (decision 8,
server side with KOBE-26); root branching supported via a follow-up ticket (decision 3).

## Open risks

- assistant-ui 0.15 marks parts of the ExternalStore/remote-thread-list API as unstable
  (`unstable_onBranchChange`, `messageRepository` semantics); pinned to 0.15.23 by the lockfile, and
  the component tests exercise the paths we use.
- A replay from seq 0 after a reload renders a long-running run's deltas again (batched); very long
  runs (tens of thousands of events) make the first render after reload slower.
- Tool denials of earlier runs show only as error results after a reload (decision 9).

## Evidence (acceptance criteria → test or command output)

| AC     | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ac-1   | `lib/chat/tree.test.ts` (9: turn folding, branches as siblings, branching inside a turn, hidden entries, offloaded/errors, malformed payloads, 5,000 entries, live prompt + deltas, continuing a committed step)                                                                                                                                                                                                                                                                                                               |
| ac-2   | `components/chat/threads.test.tsx` › thread list (6: newest first + open + URL, new thread titled from its first line, rename/Trash/restore, busy Trash refused, search with escaped snippets, X-Kobe-Team on every request); `lib/chat/thread-list-adapter.test.ts`                                                                                                                                                                                                                                                           |
| ac-3   | `conversation.test.tsx` › branches (branch picker + `POST /leaf` with the deepest entry; edit → `parent_entry_id` = parent, "Version 3 of 3"; Regenerate); `threads.test.tsx` › 409 on branch switch                                                                                                                                                                                                                                                                                                                           |
| ac-4   | `conversation.test.tsx` › "Gate 1: a refresh mid-run resumes from the event log with no gaps or duplicates" (unmount mid-run, events continue server-side, remount replays from 0, dropped connection + server replaying 2 old events → exact text once); streaming test (prompt at once, deltas, tool card, commit, finish); `lib/chat/live.test.ts`, `stream.test.ts`, `thread-controller.test.ts` (refused stream reopened, given up visibly, Reconnect; idempotent resend); `threads.test.tsx` › 410 falls back to entries |
| ac-5   | `conversation.test.tsx` › queue (Enter queues ×2, edit → PATCH, delete → cancel, next starts and streams), Steer (button and Ctrl+Shift+Enter), Stop (+ queued next starts), Stop alone keeps the streamed text                                                                                                                                                                                                                                                                                                                |
| ac-6   | `conversation.test.tsx` › "Gate 1: a sandbox killed mid-run leaves history intact and offers Retry, which runs first" (queue held), "offers Retry again after a reload, and Continue without retry resumes the queue"                                                                                                                                                                                                                                                                                                          |
| ac-7   | `conversation.test.tsx` › policy denial + egress blocks; waking notice; `live.test.ts` (tools, approvals, notices); `slots.tsx` for KOBE-37/54/55                                                                                                                                                                                                                                                                                                                                                                              |
| ac-8   | `threads.test.tsx` › errors (404, 403 way out, `team_mismatch` Reload, 503 `isolation_unavailable` + draft back in the composer, 409 `thread_busy`); `lib/api/client.test.ts` (5xx codes shown, Idempotency-Key)                                                                                                                                                                                                                                                                                                               |
| ac-9   | `threads.test.tsx` › accessibility (skip link → main, labelled complementary/search/region, composer hint, `aria-busy` while streaming, polite announcement, folded list toggle)                                                                                                                                                                                                                                                                                                                                               |
| ac-10  | Every call through `apiRequest` with the team header (test above); `/` is a static page rendering a client component; no server-side fetch                                                                                                                                                                                                                                                                                                                                                                                     |
| server | `services/server/src/thread-pending.db.test.ts` (3: active prompt then queue as edited, branch point kept, teammate/other team 404 without leaking text, 400/401/403 removed member); `openapi/document.test.ts` (documented = mounted)                                                                                                                                                                                                                                                                                        |

Commands: `pnpm build typecheck format:check` green; `pnpm lint` green except the pre-existing
`@kobe/chart` Helm 4 failure; `pnpm license:check` fails locally only on the pre-existing vitest
entry (same as main); `pnpm test --concurrency=2 -- --maxWorkers=3` green (web 256 tests);
`@kobe/server` `thread-pending.db.test.ts` 3/3 on the dev Postgres; `scripts/check-public-hygiene.sh`
ok.
