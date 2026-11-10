# KOBE-605: EA-4: Egress access browser spec, docs, gate1 values

- **Status:** spec, docs and values written; the coordinator deploys gate1 and runs the spec.
- **Branch:** `kobe-605-egress-spec` (contains KOBE-602/603/604).

## What changed

- `e2e/browser/tests/egress-access.spec.ts`: (a)+(b) member2 blocked off the ceiling, requests, the
  site admin approves in the Site console, the card shows it, the retry makes no new block; (c) an
  allowlisted cluster-ingress host (forbidden_address), approved as Internal from the card by the
  site admin, retry reaches it; (d) allowlisted private-resolving host stays blocked. Clean-up
  removes ceiling rows and team enablements it added, denies leftover requests, trashes threads.
- Docs: `docs/install.md` (Request access rewritten, new "Same-cluster hosts (Internal)", upgrade
  note for migration 0203 and `clusterIngress`, `allowedInternalCidrs` flagged as broader),
  `e2e/browser/README.md`, RUN-LEDGER entry. `docs/audit-log.md` already had every KOBE-602 row.

## gate1 values (placeholders; real values are in the local notes)

```yaml
egressProxy:
  clusterIngress:
    enabled: true
    addresses: [<INGRESS_LB_ADDRESS>/32]
    namespace: kube-system
    podSelector: { matchLabels: { app.kubernetes.io/name: traefik } }
    ports: [8443]
```

Deploy with `helm get values ... -o yaml` then `--reset-values` (never `--reuse-values`). After the
upgrade (migration 0203 runs), as site admin add `<INTERNAL_APPS_WILDCARD>` to the ceiling as
Internal and enable it for Team1 (AC-3). The spec's own hosts must NOT be covered by that wildcard:
pick `KOBE_EGRESS_INTERNAL_HOST` outside it (or temporarily remove the wildcard), else (c) skips.

## Spec environment

`KOBE_BASE_URL`, `KOBE_USER`/`KOBE_PW` (site admin and Team1 admin), `KOBE_USER2`/`KOBE_PW2`
(ordinary member), `KOBE_TEAM`, `KOBE_EGRESS_BLOCKED_HOST` (external, outside the ceiling),
`KOBE_EGRESS_INTERNAL_HOST` (on the cluster ingress, uncovered), `KOBE_EGRESS_PRIVATE_HOST` (private
address, not the ingress), optionally `KOBE_FAKE_MODEL=1`. Run: `npx playwright test egress-access`.
The scenario text assumes the status wording of KOBE-604 ("site admins were notified", "enabled
HOST"); adjust the spec if the card wording changed.

## Follow-up: blocked cards vanished after the run (gate1 run on main 5f629f30: 1 passed, 3 failed)

**Finding.** In (b), (c) and (d) the page had no "Internet access to HOST was blocked" note at all
after the retry, not even the first turn's. From the code:

- The server does persist them: the egress proxy records a pending `events` row, the relay
  (`services/server/src/egress/blocked-relay.ts`) appends an `egress.blocked` run event
  (`run_events`) to the user's _active_ run(s). The payload has no `tool_call_id`, so the web treats
  every one as a run-level notice.
- The web showed run notices only from `state.live` (`run-notices.tsx`), i.e. the run being
  followed. `#syncStream` replaces `live` with `newLiveRun` when the next run starts, and after a
  reload of a finished thread there is no live run at all. No other code read `egress.blocked` back
  (the entry tree has no notices; `resume.ts` only keeps a sessionStorage resume point for a run
  still active). So a card disappeared as soon as the next turn started or the page reloaded:
  KOBE-604's "states persist across reload" only held for the run still on the stream.
- Why (d) showed no notice for its retry either: the proxy's `BlockedReporter` reports one block
  per (sandbox, host, reason) per 30 s (`windowMs`), so a retry blocked again within 30 s makes no
  new run event. That is by design; the spec must not count notices to tell "blocked again".
- Why (c)'s retry still printed `000`: the internal host is reached through the ingress, whose
  default certificate fails curl's check (exit 60), so `%{http_code}` was 000 even though the proxy
  let it through. The probe now uses `-k` (reachability, not the certificate).

**Fix.**

- `GET /v1/threads/{id}/egress-blocked` (protocol `threadEgressBlockedResponseSchema`, server
  `egress/thread-blocked.ts`, OpenAPI): the thread's stored `egress.blocked` events, first per
  (run, domain), newest 200, each with the run's prompt entry (`runs.user_entry_id`); for whoever
  may read the thread. Read from `run_events`, so a run's cards go with its events at compaction
  (D18, 7 days after it ended); acceptable for a "try again" card.
- Web: `ThreadBlockedProvider` reads it on open, when another run is followed and when the
  followed run ends; `AnswerBlockedNotices` renders each answer's cards (by prompt entry, as the
  footers find their run) with the same `NoticeSlot` and close id (`<run>:egress:<domain>`), so a
  card closed on the live run stays closed (KOBE-468). The followed run's cards stay with the run
  notices (never shown twice); cap `MAX_ITEMS` per run.
- Spec: `retry()` returns the retry's curl HTTP code (read from its tool card output) and the
  page's notice count, and checks the first answer still shows its card. (b)/(c): first code 000,
  retry code not 000, no new notice; (d): retry code 000 again.

**Tests.** protocol `events.test.ts` (schema), server `egress/thread-blocked.db.test.ts` (owner,
reader, outsider 404, first per domain, other thread excluded), web `lib/chat/egress-blocked.test.ts`
and `components/chat/answer-blocked.test.tsx` (card kept through the next run and a reload, once;
closed stays closed; fails without the fix).

**Rerun on gate1 (coordinator).** Deploy this branch first (server route + web), then from the
worktree with the local runner and the three host values from the local notes:

```bash
KOBE_EGRESS_BLOCKED_HOST=<external host> KOBE_EGRESS_INTERNAL_HOST=<ingress host> \
KOBE_EGRESS_PRIVATE_HOST=<private host> \
  <runner> "$PWD" suite egress-access
```

Without the deploy, the "first answer keeps its card" check in `retry()` fails on the old web.
