# KOBE-531: MCP Apps: a site admin sets where each app opens (chat card, artifact column or rail)

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (commits in the worktree; the coordinator opens the PR)
- **Branch / worktree:** `kobe-531-app-placement` in `../Kobe-wt531`
- **Depends on:** KOBE-433/434 (templates and review), KOBE-438/440 (cards, Expand), KOBE-460 (rail Pickers)

## Plan

1. Migration (own commit): `connector_ui_resources.placement` text NOT NULL DEFAULT 'chat',
   CHECK IN ('chat','artifacts','rail') (0184, generated), and the custom data migration 0185
   that makes every app the KOBE-460 name rule matched `rail`.
2. Server: `PUT /v1/site/connectors/:id/templates/placement`, the review and the registry show
   the placement / template count, `GET /v1/team/apps` and the app result views carry it.
3. Web: Placement select per template in the site console's template review; `artifacts` cards
   open their tab by themselves; the rail's Pickers list `rail` apps (name rule removed).
4. Spec amendment (MA3, §7), browser spec for gate1.

## Decisions

- **Name rule for the data migration:** a row becomes `rail` when the template's `<title>` (first
  64 KiB, as the server reads it) or the opening tool's `title`, `annotations.title` or `name`
  contains "picker" in any case. The tool name counts because the KOBE-460 rule matched the
  display title, which falls back to the readable tool name (`app-title.ts`). Drifted and
  unapproved rows are migrated too; no team data, no RLS, no probe fixtures (site-wide table).
- **Route:** `PUT …/templates/placement {uri, placement}` under `site.connectors.manage` (the
  approval route's permission). 400 `invalid_request` on an unknown value or a missing field; 404
  on an unknown connector (or bad id) and on an unknown template. Audited
  `mcp.connector.template_placement_set` {connectorId, name, uri, previous, placement} (actor from
  the request) only when the value changes; setting the same value is a 200 no-op.
- **Not part of the pin:** drift upserts and approvals never write `placement`; tested
  (drift + re-approval keep `artifacts`). A first pin (`replacePinnedTemplates`, only for a
  connector with no pins) and a URL change (`dropTemplates`) re-create rows at `chat`.
- **Console entry point:** the template review used to list only drifted templates and was
  reachable only with drift. It now lists every template (approved ones after the pending ones)
  with the Placement select, and the registry row shows an "Apps" button when the connector has
  templates and nothing awaits approval (`templatesCount` added to the connector view).
- **`artifacts` in the conversation** (`components/apps/use-app-placement.ts`): the newest 3 placed
  cards of the thread (`ThreadApps.placed`, MAX_LIVE_FRAMES) read their stored result at once and
  open their tab by themselves (`ArtifactPanelApi.autoOpenApp`: no focus move, the column shows if
  hidden). The newest placed card's tab becomes active; older ones open beside it (`addTab`,
  active unchanged). Each card opens once per thread on screen (a closed tab returns the frame to
  the card and stays closed); the expanded app takes its card's slot (forced, as Expand), so the
  3-live cap holds; older placed cards beyond 3 render as cards with Expand. Under 820 px nothing
  opens by itself. Queued chips are unchanged; the card that lands opens.
- **Placement never reaches the model:** only the web views (`/v1/team/apps`, `app-results`) and
  the site console carry it; nothing in the run, the Pi mirror or the context block reads it.
- **`ui/request-display-mode`:** unchanged (the answer is the frame's current mode); ac-7 test
  on an `artifacts` card.

## Open questions (for Chris or the coordinator)

- None blocking. The browser spec `e2e/browser/tests/app-placement.spec.ts` (ac-9) was not run
  here (no gate1 access): the coordinator runs it against gate1 after deploy (the owner session;
  `KOBE_PLACEMENT_APP` defaults to "Lake Query"; it leaves one new thread behind).

## Evidence (acceptance criteria → test or command output)

- ac-1: `packages/db/src/connector-ui-resources-placement-upgrade.db.test.ts` (rail by template
  title, tool title, annotations title, tool name; chat otherwise; default and CHECK);
  migrations `0184_connector_ui_resources_placement.sql`, `0185_connector_ui_resources_placement_pickers.sql`.
- ac-2: `services/server/src/connector-template-placement.db.test.ts` (403 member, 400, 404 x3,
  audit row with actor, no audit on a no-op, drift + re-approval keep it).
- ac-3: `apps/web/components/admin/connectors-page.test.tsx` "app placement (KOBE-531)".
- ac-4: `team-apps.db.test.ts`, `app-results.db.test.ts`, `apps/web/lib/apps/app-results.test.ts`.
- ac-5: `apps/web/components/apps/app-placement.test.tsx` (chat, reopened thread with newest
  active, close returns to card, rail launch, 3-live cap, under 820 px),
  `tool-card-app.test.tsx` (tool card), `lib/chat/artifact-tabs.test.ts` (`addTab`).
- ac-6: `apps/web/components/shell/rail-pickers.test.tsx` (rail placement listed; a chat app
  named "Column Picker" is not; the list keeps every app).
- ac-7: `app-placement.test.tsx` "an app's display-mode request never moves it".
- ac-8: `docs/specs/mcp-apps-host.md` MA3 amendment 2026-10-31 and the §7 row; this ledger;
  `pnpm verify` and the db runs below.
- ac-9: `e2e/browser/tests/app-placement.spec.ts` (coordinator, gate1, after deploy).
