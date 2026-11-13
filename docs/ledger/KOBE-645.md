# KOBE-645: SMA13 Memory notification kinds (migration) and digest/reminder machinery

- **Status:** in review (two local commits; not pushed)
- **Branch / worktree:** `kobe-645-sm-notifications` in `../Kobe-wt645`, on `kobe-380-sm-stewards-migration` (PR #533)
- **Depends on:** KOBE-377 (kind names), KOBE-380 (migrations up to 0219)

## Plan

1. Migration commit alone: `0220_memory_notifications` (generated) + `0221_memory_notifications_rls`
   (custom), upgrade test, probe fixture, tenancy registry.
2. Feature commit: protocol payload rules, server `notifications/memory.ts` (emit, digest,
   reminders, one-runner job), list API, bell words and deep links, guide.

## Decisions

- **Names:** KOBE-377's `MEMORY_NOTIFICATION_KINDS`, spread into protocol `NOTIFICATION_KINDS`
  and listed in the DB `NOTIFICATION_KINDS` (CHECK). Coordinator 2026-11-13 (Q1): the shared list
  gains every kind the v1.3 briefs (378–413, 645–653) name that it lacked, in the migration commit:
  `memory.review.candidates_ready` (KOBE-396 fallback), `memory.proposal.{changes_requested,expired}`
  (397/651), `memory.suggestion.expired` (651/652), `memory.site_proposal.{confirmed,changes_requested,expired}`
  (403/653) — 19 kinds. Reminders and digests stay `memory.review.reminder|digest` with
  `related_kind` (the brief's `*_reminder` names).
- **Columns (all nullable, memory kinds only, check `notifications_memory`):** `memory_scope`
  (near_full: `team|site`), `memory_object_id` (proposal/suggestion/Site proposal; a reminder's
  object; no FK: source tables come later and delete their own notices), `related_kind` (digest:
  the kind rolled up; reminder: the pending object's `*.received` kind, null = To review
  candidates; pending kinds also include Site `confirmed` and `changes_requested`), `item_count`
  (digest count; candidates_ready count), `project_id` (suggestions, composite FK to projects,
  cascade). `memory.review.candidates_ready` names its thread (`thread_id`, the only memory kind
  that does; the bell's Open conversation) and optionally the pass in `memory_object_id`.
  `actor_user_id` is optional on proposal/suggestion/Site proposal kinds, null on the others.
  The check is wrapped in `COALESCE(..., false)`: a null in an `IN` list made it pass.
- **Digest at emit time, not in a sweep:** `notifyMemory` takes a transaction advisory lock per
  (team, recipient, kind); if a digest for that kind was opened within the hour it grows
  (`item_count + 1`, unread again); else if 5 notifications of the kind exist in the last hour
  a digest opens with count 1; else a plain notification. So the first five arrive one by one and
  the rest roll into one item; nothing a person already saw is rewritten. Reminders go through
  the same path (a burst of due reminders rolls up too).
- **Reminders:** team table `memory_reminders` (object, related kind, recipient, project, due_at,
  sent_at), FK to team_members (row goes with the membership), unique (team, object, recipient).
  `registerMemoryReminder` (due = now + 7 days, idempotent, non-members skipped),
  `settleMemoryReminders` (deletes the object's rows when decided). Sweep claims due rows
  `FOR UPDATE SKIP LOCKED` per team in `withTeam`, emits, stamps `sent_at`.
- **One runner:** `MemoryReminderJob` under session advisory lock `kobe.memory-reminders`
  (`createPgReconcileLock`, like offboarding/connector refresh), every 15 min, registered as
  server job `memory-reminders` in `startup/jobs.ts`. SKIP LOCKED makes an overlap harmless.
- **Recipients:** inactive users and non-members are skipped (not in the result).
- **Deep links** (`apps/web/lib/notifications/memory.ts`, `MEMORY_PAGES`): proposal received →
  `/admin/team/memory?proposal=<id>`; proposal decided → `/me/memory?proposal=<id>`; suggestion →
  `/me/projects/<project>?suggestion=<id>`; Site proposal received → `/admin/site/memory?site_proposal=<id>`;
  Site proposal decided → `/admin/team/memory?site_proposal=<id>`; near_full → Workspace/Site memory;
  reminder → its object's link (To review: `/me/memory?review=<id>`); digest → the list of the
  rolled-up kind. Later tickets' pages read these query parameters.
- **Docs:** guide `memory.md` "Memory in your notifications" and the layout page's bell bullet;
  `/llms.txt` follows the guide. `docs/install.md` upgrade note for 0220/0221.

## API for later tickets (KOBE-397, 403, 651-653)

```ts
import {
  notifyMemory,
  registerMemoryReminder,
  settleMemoryReminders,
} from "../notifications/memory.js";
await withTeam(db, teamId, async (tx) => {
  await notifyMemory(tx, teamId, curatorIds, {
    kind: "memory.proposal.received",
    objectId,
    actorUserId,
  });
  await registerMemoryReminder(tx, teamId, {
    objectId,
    about: "memory.proposal.received",
    recipients: curatorIds,
  });
});
// on decision: settleMemoryReminders(tx, teamId, objectId) + notifyMemory(... "memory.proposal.accepted" ...)
```

## DB/security review (docs/ledger/review-645.md, 2026-11-13) — fixed

- M1: the sweep re-checks the recipient's right at send (curator for Workspace proposals;
  project owner/editor or Team admin for suggestions; Team admin for Site step 1; Site admin or
  Site steward for `confirmed`); a reminder whose recipient lost it is deleted, not sent.
- L1: `notifyMemoryAll` validates, then locks in (kind, recipient) order; `notifyMemory` wraps it.
- L3: one team's failure is logged and skipped; its reminders stay owed.
- L4: digest lock must live to commit (it guards the count); documented "notify last".
- L5: `memory_reminders_user_idx`, `memory_reminders_project_idx` in 0220 (migration amended).
- L6: actor must be a member (Site curator allowed for Site decisions); candidates_ready thread
  must be the recipient's own; otherwise throws.
- L2: upgrade lock noted in `docs/install.md` (not split: needs hand-written NOT VALID SQL).

## Open questions (for Chris or the coordinator)

1. Resolved 2026-11-13: missing kinds added (see Names).
2. Site proposals and Site near_full notices still need a `team_id` (notifications are team rows):
   KOBE-403 must pick the team (the proposing Workspace, or each steward's own membership).
   Coordinator: fine, left to KOBE-403.
3. `/admin/site/memory` does not exist yet (KOBE-385/403 builds it); site links 404 until then,
   but nothing emits site kinds before that. Site proposal outcomes link to the Workspace console
   Memory page (Team admins); a member proposer may lack access there (KOBE-403 to refine).

## Evidence (acceptance criteria → test or command output)

- ac-1: `packages/db/src/memory-notifications-upgrade.db.test.ts` (older rows kept, every kind's
  shape accepted/refused, RLS on `memory_reminders`); probe suite + catalog db tests green;
  `db:check` clean; server `memory/semantic-contract.test.ts` (DB list = protocol list).
- ac-2: `services/server/src/memory-notifications.db.test.ts` (digest >5/hour, unread on growth,
  new hour, 10 concurrent emits, reminder once after 7 days, settle, held lock blocks both
  replicas, racing sweeps send once, reminder burst digested).
- ac-3: `apps/web/lib/notifications/memory.test.ts` (title, label, deep link for all 19 kinds),
  `components/chat/notification-bell.test.tsx` (memory item opens its link, marks read); list
  API returns memory fields (server db test above).
- ac-4: guide pages above; `packages/guide` tests green.
