# KOBE-449: Site-key connectors never reach Pi (KOBE-303 gap)

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** runs part merged (PR #322); audit follow-up on `group-32-site-key-connectors` (not pushed)
- **Branch / worktree:** `fix-449-sitekey-runs` (merged), then `group-32-site-key-connectors` in `../Kobe-wt449`
- **Depends on:** KOBE-303, KOBE-436 (MA8)

## Decisions

- **One "usable site key" check:** `usableSiteKeyIds` in `connectors/site-key.ts`: the
  connector is not removed, it is in `site` mode with `api_key` auth, and the key's `url_sha256`
  matches the current URL. `revealSiteKey` (proxy, probes) uses the same query and also needs the
  ciphertext to open. MA8 (`apps/catalog.ts`), the app-card insert check
  (`apps/app-cards.ts stillLaunchable`), the run's connectors and `/v1/team/connectors` all call it.
- **Runs:** `loadTeamConnectorRows` carries `credentialSource`; `connectedConnectorNames` takes
  the usable site keys: a `site` connector counts only through its site key (never a member
  grant), every other one as before. Exposure and agent globs still apply (`buildRunMcp`).
- **Skill evals** (`noPersonalGrants`) get neither grants nor site keys (KOBE-325/326 unchanged).
- **Other places checked:**
  - schedules (auto mode): same resolver (`PINNED_AGENTS`), fixed with it; the proxy side already
    served the site key (KOBE-303 test 4);
  - `/me/connectors`: showed "Provided by your organization" for every `site` connector, set or
    not. `/v1/team/connectors` now carries `site_key_ready` (the shared check); without a usable key
    the card says the organization has not set it yet;
  - agent catalog / Orbit tool list (`orbitMcpToolNames`): applies no user grants at all (the
    agent's tool surface), nothing to fix;
  - KOBE-431 probe (`chooseProbeCredential`): already tries `revealSiteKey` first;
  - MCP Apps call path (`apps/call.ts`): uses MA8 and `revealForMember`, already right.

- **Precedence (2026-10-22):** the connector's `credential_source` decides, never the member, so
  there is no "both" case: `site` uses only the site key (members' grants are ignored, and members
  cannot add one: `provided_by_site`); `member` uses only the member's own grant (a site key left
  from an earlier `site` mode is ignored). The DB check `connectors_credential_source` keeps the two
  exclusive. connectors_off, exposure, agent globs and approvals/policy are unchanged.
- **Audit which key (group 32):** an allowed `mcp.tool_call` row carries `credential`
  (`none` | `member` | `site`, from `credentialUsed` in `mcp/catalog.ts`); the internal grant answer
  carries `source` (`member` | `site`, absent from older servers = `member`), and the proxy's
  `mcp tools/call` log line says `credential`. No key or hint in either. No migration (audit
  targets are JSON, schema in `packages/db/src/audit/events.ts`).

## Evidence

- ac-1, ac-2: `runs/run-mcp.test.ts` "connectedConnectorNames with a site-wide key";
  `runs-resolver.db.test.ts` "KOBE-449: a usable site-wide key connects every member…" (member
  without a grant listed, read_only exposure, deny glob, eval none, stale URL, re-entry, removed,
  key left after switching back to member mode).
- `/me/connectors`: `connector-site-key.db.test.ts` (`site_key_ready` true, stale false, re-entered
  true, removed false); `my-connectors.test.tsx`.
- ac-3 e2e: `e2e/run.sh` MCP section, "KOBE-449" (suite shard): the Owner's agent with only
  `e2e-site`; the fake model's `tools?` lists `mcp__e2e_site__get_thing`, a `steps:` run calls it,
  the fake server logs the call once with the site key. Not run locally (needs k3d).
- ac-4 (gate1): needs a deploy; not done here.
- Audit follow-up: `mcp/catalog.test.ts` (credentialUsed); `connector-site-key.db.test.ts` test 4
  (`source: "site"` on the grant, `credential: "site"` on the audit row); `mcp.db.test.ts`
  (`credential: "none"`); `connector-grants`/`-oauth`/`-refresh` db tests (`source: "member"`);
  mcp-proxy `credentials.test.ts` and `mcp.test.ts` "KOBE-449: calls with the site key and logs
  which key was used, never the key". Server test:db 2178/2178; mcp-proxy 131/131.
