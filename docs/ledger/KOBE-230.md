# KOBE-230: Web: team admin toggle for web search (opt-in)

- **Status:** in review
- **Branch / worktree:** `kobe-230-web-search-toggle` in `../Kobe-wt230`
- **Depends on:** KOBE-113

## Plan

Web-only: new team console section "Web search" (`/admin/team/web-search`, permission
`team.connectors.manage`) over the existing `/v1/team/web-search` GET/PUT.

## Decisions

- No server change: GET already returns `available` (install has an enabled provider), `enabled`,
  and `provider`, which is the "provider configured" signal.
- Separate section rather than a card on Connectors, so the connectors page and its tests are untouched.
- When `available` is false the toggle is not rendered; the page says an install admin must set up a provider.
- Copy names the provider and says query text leaves the install.

## Open questions (for Chris or the coordinator)

None.

## Evidence (acceptance criteria → test or command output)

| Criterion                            | Evidence                                                            |
| ------------------------------------ | ------------------------------------------------------------------- |
| ac-1 on/off, hidden without provider | `apps/web/components/admin/team-web-search-page.test.tsx` (3 tests) |
