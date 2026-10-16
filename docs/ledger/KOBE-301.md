# KOBE-301: Status colour and activity cues

- **Status:** committed on the group branch (not pushed)
- **Branch / worktree:** `group-4-composer` in `../Kobe-g4`
- **Depends on:** KOBE-282 (theme tokens, `data-theme`), KOBE-281 (chat portals, untouched)

## Plan

1. One set of status tokens in `apps/web/app/theme.css` (light, chosen dark, OS dark), mapped
   into Tailwind (`text-status-running`, `bg-status-attention-bg`, … in `app/chat-global.css`)
   and read by CSS modules as `var(--kobe-status-*)`, so G7's Tailwind consoles can use them.
2. A `StatusDot` / `StatusBadge` pair (`components/ui/status.tsx` + `status.module.css`) holds
   the dot, the soft pulse and its `prefers-reduced-motion` off switch.
3. The rail's activity: live for threads this tab holds open, else `GET /v1/threads/activity`.

## Decisions

- **Server change (smallest):** thread summaries carry `pending_approval: true` while the caller
  has a pending, unexpired approval on the thread (only the run's user may decide one, KOBE-37);
  absent otherwise. Computed in `summarize()` inside the existing `withTeam` transaction, one
  `SELECT DISTINCT thread_id` on the partial `approvals_pending_idx`, `team_id` and `user_id`
  stated. No migration. `openapi.json` regenerated. Tests: `thread-activity.db.test.ts` (own
  pending vs expired/denied/decided, the thread read agrees, a team-share reader never sees it,
  other teams). Search hits don't carry it (the rail doesn't use search).
- **Activity endpoint (review S2/S3):** `GET /v1/threads/activity` lists the caller's own live,
  non-test threads whose status is `running`, `approval` when an approval only they can decide
  waits there (EXISTS on approvals). One query on `threads_owner_activity_idx` under `withTeam`,
  `team_id` stated, no project read; capped at 200. OpenAPI regenerated; db tests cover own
  running/approval, expired, Trash, a team-share reader and another team. (The test caught a
  drizzle trap: a bare `${threads.id}` inside the raw subquery rendered unqualified and bound to
  `approvals.id`; the subquery names `threads.*` in full.)
- **Live source for the rail:** a thread held open (`ChatSession.acquire`) follows its controller
  (`ThreadActivityStore`, immutable snapshots). Other threads follow the activity read, polled
  every 15 s **only while the tab is visible**, plus on focus, when the tab shows again and when
  a held thread that ran is let go. Its answer is merged into the store (unlisted = idle); the
  thread lists are never reloaded for activity, so loaded pages stay. It also sees runs this tab
  never started (schedules, another device). Before its first answer the list summary
  (`status`, `pending_approval`) decides. Known limit: a hidden tab's title follows the open
  thread live but other threads only as of the last read (no polling while hidden, by design).
- **Only the member's own runs (review S1):** a thread shared with them (`readOnly`) is idle for
  the rail dot and the tab title, from the summary and from the live controller; the endpoint
  never lists it.
- Rail row: the dot is decoration; the state ("Running" / "Waiting for your approval") is the
  row button's `aria-describedby`, so its accessible name stays the title (specs find rows by
  title).
- The "Waiting for your approval" note above the composer is the steering panel's existing
  approval phase (CE10), now amber with a clock and a **Show** button that scrolls the card
  into view; a second note would have said the same thing twice.
- The approval card scrolls into view (`block: nearest`, smooth unless reduced motion) once per
  request, **only while the message list follows the latest message** (`data-kobe-follow =
pinned`, KOBE-288): never when the member scrolled up or while the position is restored
  (`pending`), never for a reader or an expired request (review M1). Otherwise the steering
  panel's amber note and Show (a deliberate scroll) and the rail/tab cues say it.
- Budget levels use the exact share (79.6 % stays plain although the text rounds to 80 %).
- The tab title follows the rail: `(!) ` if any thread waits for an approval, else `● ` if any
  runs; only while `document.visibilityState === "hidden"`; restored on visibilitychange, focus,
  when the state ends, and on unmount. Only prefixes it added are stripped.
- Tool steps: `OUTCOME_TONE` (running → running, waiting → attention, error/denied → failed,
  done → done) colours both icon and label; the spinner keeps `motion-reduce:animate-none`.
- Stop: outline button with the failed tint (`STOP_TINT`), shown only while a run holds the
  thread. The bell's count pill (also Jump to latest's count) uses the accent pair.
- **Departure (ac-6, context gauge):** the gauge keeps CE14's thresholds (orange 65 %, red 85 %,
  Compact offered at red; spec CE14/U20 are final). Its colours now come from the status tokens
  (`--kobe-gauge-warn/full` alias attention/failed). The 80 %/100 % rule applies to budgets:
  there is no budget gauge in the chat, so the team console's usage lines (team, members, site
  percentages) turn amber at 80 % and red at 100 % with an icon and "· used up".
- In Trash stays grey (`--kobe-status-idle`, darker than `--muted-foreground` so it passes AA on
  the rail panel too).

## Contrast (WCAG AA, text 4.5:1; checked by `app/theme-css.test.ts`)

| Token     | Light     | page / rail / card / tint | Dark      | page / rail / card / tint |
| --------- | --------- | ------------------------- | --------- | ------------------------- |
| running   | `#166534` | 7.1 / 6.5 / 7.1 / 6.5     | `#4ade80` | 11.4 / 8.7 / 10.3 / 8.6   |
| attention | `#a14b05` | 6.0 / 5.5 / 6.0 / 5.4     | `#fbbf24` | 11.9 / 9.1 / 10.7 / 8.7   |
| failed    | `#b91c1c` | 6.5 / 5.9 / 6.5 / 5.3     | `#f87171` | 7.2 / 5.5 / 6.5 / 5.8     |
| done      | `#3f7a55` | 5.1 / 4.7 / 5.1           | `#8fbf9f` | 9.5 / 7.3 / 8.6           |
| idle      | `#5c5c5c` | 6.7 / 6.1 / 6.7           | `#a3a3a3` | 7.8 / 6.0 / 7.1           |

Attention on the approval card (`--admin-warn-bg`): 5.4 light, 7.6 dark. Count pill text on
accent: 7.4 light (white on `#2449c7`), 8.7 dark (`#0a0a0a` on `#8fa8ff`).

## Screenshots (ac-7): pending gate1

Not attached yet: the coordinator captures gate1 screenshots after deploy.
`e2e/browser/tests/status-cues.spec.ts` attaches light and dark PNGs of the header badge, the
rail row and Stop to the Playwright report, and switches threads **in the app** (rail clicks, no
page load), so its "other thread" step proves the live path.

What the component tests prove (happy-dom has no cascade or layout, so they pin tone classes,
data attributes, labels and the CSS contract, not painted colours):

- Header badge: tone (`running` / `attention` / `idle`), the label text, the pulsing dot.
- Rail: the dot's tone and pulse, the "Running" / "Waiting for your approval" description, live
  for the open thread, from the activity read for others (incl. a run started elsewhere), no dot
  for a shared thread, no list reloads, no reads while hidden.
- Approval: amber class on icon and note, Show scrolls to the card, the note goes once allowed;
  scroll on arrival only when pinned, never unpinned/pending, reader or expired.
- Tool steps: tone per outcome on icon and label, spinner with `motion-reduce:animate-none`.
- Stop, bell, gauge, budgets: Stop's tint classes, the count pill's CSS, the gauge aliases, budget
  levels and their icon and words.
- Tokens: values and AA ratios parsed from theme.css (`app/theme-css.test.ts`); reduced motion
  from status.module.css. Painted colour (green badge and dot, red Stop, no pulse under reduced
  motion): only the e2e spec on gate1.

## Evidence (acceptance criteria → test or command output)

- ac-1: `components/chat/status-cues.test.tsx` "thread header badge" (Running pulsing, Interrupted
  amber, In Trash grey, label kept).
- ac-2: `components/chat/thread-activity.test.tsx` (open thread live; another thread open:
  running → approval → idle via the list; no polling while idle);
  `lib/chat/thread-activity.test.ts`; server `src/thread-activity.db.test.ts`.
- ac-3: `status-cues.test.tsx` "approval card" (accent + icon, scrollIntoView, note in the
  composer footer until Allow).
- ac-4: `status-cues.test.tsx` "tool steps".
- ac-5: `thread-activity.test.tsx` "tab title" (hidden only, focus/visible restore, state end,
  unmount).
- ac-6: `status-cues.test.tsx` "smaller cues"; `components/admin/budgets-pages.test.tsx`
  "budget usage colours".
- ac-7: `app/theme-css.test.ts` "status tokens" (AA in both themes, gauges alias the tokens);
  reduced motion: `thread-activity.test.tsx` (CSS) and the e2e spec's second test.
- Runs: web unit tests 1493/1493; server unit 1328 pass; server `test:db` 1515/1515 (112
  files); format, lint, typecheck clean.
