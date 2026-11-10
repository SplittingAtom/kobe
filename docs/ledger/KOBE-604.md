# KOBE-604: EA-3: Blocked card and Site console requests (web)

- **Status:** in review (committed on `kobe-604-egress-card`, not pushed)
- **Spec:** `docs/specs/egress-access.md` §3 (card and consoles), EA1-EA3

## What changed

- **Card** (`apps/web/components/chat/egress-notice.tsx`): Request access for every block whose payload
  says `request_access`. The sentence names who decides: "Your team admins" (reason `not_enabled`, or
  the request's `scope` `team`) or "The site admins". Status text after a request follows the scope.
  For a viewer who may decide (site admin: any; team admin: team scope only) the card adds a labelled
  select "Allow" (pattern choice), for site admins a checkbox "Internal (same cluster)" (checked by
  default when reason is `forbidden_address` or the request is internal), and buttons Approve / Deny.
  Approve creates the request first when the viewer has none pending, then decides it; Deny appears
  only with a request to deny. Only an explicitly picked pattern is sent (else the server uses the
  request's own pattern, which matters for a team admin and a wildcard in the ceiling). Results:
  "Enabled <pattern> for <team>. Ask the agent to try again." / "Denied access to <host> for <team>.";
  server errors are shown as returned, with the controls kept. Focus moves to the status paragraph
  after request or decision.
- **Roles** only show buttons: `ChatApi.egressViewer()` reads `/v1/me` (`siteRole`) and `/v1/team`
  (`permissions` has `team.egress.manage`, team name), once, only for a card that can be acted on.
- **ChatApi**: `requestEgressAccess(domain, threadId, reason?)`, `decideEgressRequest(id, input)`,
  `egressViewer()`. `EgressRequest` gains optional `scope`, `internal`.
- **Pattern choice** (`lib/egress-patterns.ts`): host first, then `*.<parent>` up the chain with at
  least two labels after `*.`. The browser has no Public Suffix List, so two-level registries
  (`co.uk`, `com.au` ...) are recognised by shape; anything else the server refuses (`invalid_pattern`,
  shown plainly). The server is the authority.
- **Site console › Egress**: "Access requests" section (`SiteEgressRequests`) listing site-scope
  pending requests with team, requester, thread, time, a pattern select, an Internal checkbox, Approve
  and Deny; focus returns to the list/heading after a decision. Each ceiling row has an "Internal
  (same cluster)" checkbox (`PUT /v1/site/egress-ceiling/:domain {internal}`).
- **Team console** requests table: a Scope column when the server reports `scope`.

## Names for the browser spec (KOBE-605)

Card: button "Request access to <host>", combobox "Allow", checkbox "Internal (same cluster)",
buttons "Approve access to <host>" / "Deny access to <host>", fieldset "Decide access to <host>".
Site console: table "Pending site requests (n)", combobox "Pattern to enable for <host>", checkbox
"Internal (same cluster) for <host>", buttons "Approve <host> for <team>" / "Deny <host> for <team>";
ceiling row checkbox "<domain> internal (same cluster)".

## Evidence

`components/chat/egress-notice.test.tsx`, `components/admin/egress-pages.test.tsx`,
`lib/egress-patterns.test.ts`; web typecheck and eslint clean.
