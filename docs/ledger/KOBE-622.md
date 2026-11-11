# KOBE-622: KA-5 Site console admin tools (Kobe MCP)

- **Status:** committed on `kobe-622-site-tools` (no PR; coordinator merges with KOBE-621)
- **Branch / worktree:** `kobe-622-site-tools` in `../Kobe-wt622`
- **Depends on:** KOBE-618, KOBE-619; spec `docs/specs/kobe-admin-mcp.md` §5 Site list, §6, §8, KA8

## What landed

34 Site console tools in `services/server/src/kobe-mcp/tools/site/` (registered in
`tools/index.ts` by one spread, `KOBE_SITE_TOOLS`). Each: `site_<area>_<verb>`, strict zod
input/output, `scope: "site"`, the console page's permission, one console route run in process.

| Area (page permission)                                         | Reads                                                                                                                                      | Writes (before-state → route condition)                                                                                                                                                                                                                |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Users (`site.users.manage`)                                    | `site_users_list`                                                                                                                          | `site_users_deactivate`, `site_users_reactivate` (`from_state` → `expectedState`)                                                                                                                                                                      |
| Teams (`site.teams.manage`)                                    | `site_teams_list`                                                                                                                          | `site_teams_create` (absent; unique slug)                                                                                                                                                                                                              |
| Invites (`site.users.manage`)                                  | `site_invites_list`                                                                                                                        | `site_invites_create` (route refuses existing account), `site_invites_revoke` (id+email; 404 when not open)                                                                                                                                            |
| Models (`site.models.manage`)                                  | `site_models_list`                                                                                                                         | `site_models_catalog_update` (label, prices, limits; `change.from` → `expected`)                                                                                                                                                                       |
| Connectors (`site.connectors.manage`)                          | `site_connectors_list`                                                                                                                     | `site_connectors_set_status` (`expectedStatus`)                                                                                                                                                                                                        |
| Egress (`site.egress.manage`)                                  | `site_egress_ceiling_list`, `site_egress_requests_list`                                                                                    | `site_egress_ceiling_add`, `site_egress_ceiling_set` (`expected_in_ceiling`), `site_egress_requests_decide` (pending; route refuses `already_decided`)                                                                                                 |
| Skill Registry (`skillReviewAllows`)                           | `site_skill_reviews_list` (queue.read)                                                                                                     | `site_skill_reviews_claim` (claim), `_comment` (comment), `_decide` approve/request changes/reject (approve; route checks the exact action), `_reject_and_block` (reject_and_block) — states are monotonic, the route refuses decided/claimed versions |
| Blocklist (`site.blocklist.manage`)                            | `site_skill_blocklist_list` (route keyset cursor)                                                                                          | `site_skill_blocklist_add` (409 already_blocked), `_remove` (404 when not blocked)                                                                                                                                                                     |
| Grants (list `site.users.manage`, change `site.grants.manage`) | `site_grants_list`                                                                                                                         | `site_grants_give`, `site_grants_take` (held / not held)                                                                                                                                                                                               |
| Branding (`site.settings.manage`)                              | `site_branding_get`                                                                                                                        | `site_branding_set` (app name, show name, theme, logo colour; `expected` under an advisory lock)                                                                                                                                                       |
| Budgets (`site.budgets.manage`)                                | `site_budget_get`                                                                                                                          | `site_budget_set` (`expected` under the row lock)                                                                                                                                                                                                      |
| Usage (`site.usage.read`), Audit (`site.audit.read`)           | `site_usage_read` (totals, top 25 teams/models), `site_audit_list` (keyset `before`, ≤50, no IP/UA, IP/UA-like keys stripped from targets) | —                                                                                                                                                                                                                                                      |

## Framework changes (shared files, small)

- `catalog.ts`: `KobeRoute.query` (URL-encoded); site tools may name `skillReview: SkillReviewAction`.
- `access.ts`: `KobeAccess.grants` (read with the roles); `personAllows` uses `skillReviewAllows` for
  Registry tools, so a Skill reviewer lists and calls only claim/comment/decide/list.
- `execute.ts`: `SAFE_PATH` allows `.` and `*` (domains, model aliases); `.`/`..` segments refused.
- `session-contract.test.ts`: site samples from `testing/kobe-site-samples.ts`; `users/deactivation.ts`
  exempt (it deletes the _target's_ sessions). `kobe-mcp.db.test.ts` contract filtered to team tools.

## Route changes (optional fields; the console sends none, behaviour unchanged)

- `POST /site/users/:id/{deactivate,reactivate}` body `{expectedState}`: 409 when the conditional update changed nothing.
- `PATCH /site/connectors/:id` `expectedStatus` (under the row lock).
- `PUT /site/egress-ceiling/:domain` `expected_in_ceiling` (under the row lock).
- `PATCH /site/models/catalog/:alias` `expected` {label, prices, limits} (under the row lock).
- `PUT /site/budget` `expected` (row lock added).
- `PUT /site/branding` `expected`; PUT and reset now take an advisory lock. `openapi.json` regenerated.

## Left out (console only)

- KA8: break-glass, ownership transfer, site roles, legal hold, retention, isolation; every
  irreversible deletion (users never deleted; teams, connectors, catalog models, providers, ceiling
  domains are not removed by any tool).
- Also: registering/editing connectors (URL, auth, site key, pinning, tool and template approval —
  need a probe with the admin's key), model providers and keys, adding catalog models, team rename,
  resending invites, ceiling presets and `internal` flag, Registry withdraw/revoke/Default tags/
  settings/re-runs/acknowledgements, branding uploads and reset, site settings (sign-in, 2FA,
  `kobe_mcp.mode` — the agent must not switch its own guard), audit export/forwarding/integrity,
  agent roster and gallery pages.

## For KA-7 (guide pages to update; not rewritten here)

- `docs/guide/admin/site-admin.md`: which Site console actions have a Kobe tool (table above), what stays console-only.
- `admin/admin-from-a-conversation.md` (new, KA-7): site tools need a site role (or the Skill reviewer
  grant for the review tools) **and** the run's team at `read`/`read and write`; `docs` hides them.
- `for-agents/working-in-a-sandbox.md`, `for-agents/concepts.md`: `change: {from, to}` inputs, read
  first; `changed_since_approval`; never retry.
- `internet-and-approvals/internet-access.md`: site egress requests and ceiling via the agent.
- `agents/skills.md`: Skill reviewers can review from a conversation (claim, comment, decide).
- `appearance.md`, `models.md`: branding and catalog changes from a conversation ask first.
- `reference/`: audit reads through the agent never show IP or user agent.

## Open risks

- `site_egress_requests_decide`/`_list` see the route's newest 200 requests only.
- A deactivation refused `changed_since_approval` has still re-revoked the target's sessions (idempotent).
- Limits count site reads with team reads (60/min per person).

## Evidence

- ac-1, ac-2, ac-4: `kobe-mcp-site.db.test.ts` "who lists and calls" (team admin lists none,
  forged call refused with approval; reviewer lists the 4 reviewer tools, block refused; switches).
- ac-3: same file "audit reads" (row with IP/UA recorded, tool output has neither) +
  `kobe-mcp/site-tools.test.ts`.
- ac-5: "site catalog contract": 34 tools 403 as a team admin (branding read: Kobe layer), answered
  as a site admin, every write's console events carry `viaAgent` of the run; session contract green.
- Route conditions: "the routes' own before-state conditions". Unit: `kobe-mcp/site-tools.test.ts`.
