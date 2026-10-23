# Kobe — Gallery agents (D19, D21; KOBE-87, KOBE-494)

Status: **D19/D21 amended by Chris, 2026-10-23** (KOBE-494). Ledger: `docs/ledger/KOBE-494.md`.

## 1. What the gallery is

Gallery agents are site-wide agents every team can use and fork (D21). Their definitions live in
the repository (`services/server/src/gallery/definitions.ts`), each with a key and a monotonic
generation. The server seeds them at every start (`gallery/seed.ts`): a newer generation replaces
the draft and publishes one new immutable version (D19); an older replica changes nothing; a
definition that leaves the repository archives its agent.

## 2. Decision (Chris, 2026-10-23): site admins edit gallery agents; an edit detaches

Until KOBE-494 gallery agents were read-only through the API: only a release changed them.
Amended:

- **Edit.** Site admins (Owner, Admin; `site.gallery.manage`, checked on every request) edit a
  gallery agent in the Site Console with the same two-tab agent creator teams use (KOBE-476):
  Save draft (`PUT /v1/site/gallery/agents/{id}`, If-Match), Publish
  (`POST .../{id}/publish`, a new immutable version; D19 unchanged), version history
  (`GET .../{id}/versions`). Dangerous approval mode only where the site policy allows it
  (site admins, AC1); tools are chosen from the site's active connectors
  (`GET .../builder-options`). Creating, deleting, suspending and unarchiving gallery agents stay
  closed (405 `gallery_read_only`); archived agents stay as they are.
- **Customized.** The first saved draft or publish marks the agent Customized
  (`site_agents.customized_at`, `customized_by`, `customized_from_generation`; audited
  `agent.customized`). The seed never overwrites a customized agent (`skipped_customized`) but
  records the repository's newer generation, so the console shows "A newer repository version is
  available".
- **Compare** (`GET .../{id}/compare`) shows the repository definition and the agent's current
  version side by side.
- **Reset to repository** (`POST .../{id}/reset`, asks first) clears the marker (audited
  `agent.reset_to_repository`) and seeds the repository definition at once: published as a new
  version, and later releases update the agent again.
- **Teams.** Unaffected by an edit until they start new threads on it; threads keep their pinned
  version and forks keep the version they copied. A fork made after an edit copies the customized
  version.
- **Audit.** Draft saves are `agent.updated` and publishes `agent.published`, both with
  `scope: "gallery"` and the site admin as actor.
- **Backup and restore.** A customized gallery agent is real data, not a start-up seed.
