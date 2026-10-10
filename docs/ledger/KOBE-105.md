# KOBE-105: team admin UI for connectors (60b)

- **Status:** in review
- **Branch / worktree:** `kobe-105-team-connector-ui` in `../Kobe-wt105`
- **Depends on:** KOBE-104 (team API), KOBE-102 (drift), KOBE-108 (API-key grants)

## Decisions

- **Team page** `/admin/team/connectors` (`components/admin/team/connectors-page.tsx`, section now READY):
  one card per registered connector: enable / save exposure / disable, exposure radios
  (read-only, all, chosen), tick list of pinned tools. Drifted tools are listed as "Unavailable", cannot
  be ticked, and a stale tick on one is dropped before sending. A connector disabled by the install admin
  cannot be enabled (an enabled one can still be turned off).
- **Risk labels:** each tool shows Read-only/Write and Open-world/Closed-world; unannotated tools are write
  and open-world (MCP defaults), stated on the page.
- **Member flow** `/me/connectors` (`components/me/my-connectors-page.tsx`, linked from My agents): lists
  enabled, active `api_key` connectors with the caller's grant hint; add / replace / remove. Field is
  `type=password`, emptied after every submit, never rendered back; only the hint is shown.
- **Small server change:** `GET /v1/team/connectors` tools gained `open_world` (`openWorldHint !== false`);
  without it the UI could not label open-world. No migration. `credentials_unavailable` (503) joins the
  5xx codes whose message the client shows.

## Open questions

- None.

## Evidence

- ac-1: `components/admin/team-connectors-page.test.tsx` (enable, exposure, custom list, disable).
- ac-2: same file "lists connectors off by default, with tools labelled by risk".
- Keys: `components/me/my-connectors.test.tsx` (key absent from the DOM after save).
