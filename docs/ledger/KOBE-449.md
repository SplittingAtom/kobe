# KOBE-449: Site-key connectors never reach Pi (KOBE-303 gap)

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (not pushed)
- **Branch / worktree:** `fix-449-sitekey-runs` in `../Kobe-449`
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
