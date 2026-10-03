# Agent versions: operations

Published agent versions (spec D19, KOBE-46) are immutable. The database refuses to change or
delete them, threads pin them with NO ACTION foreign keys, and the app never deletes an agent that
has versions: it archives it instead. That is what keeps old conversations reproducible. It also
means a version's prompt stays in the database until an operator erases it, including the
personal agents of a deactivated user.

## Limits

| Setting                                 | Default                             | Where                           |
| --------------------------------------- | ----------------------------------- | ------------------------------- |
| Versions per agent                      | 1000                                | `KOBE_AGENT_MAX_VERSIONS`       |
| Publishes and rollbacks per user        | 30 per 10 minutes                   | server (`AGENT_LIMIT_DEFAULTS`) |
| Live (not archived) agents per location | team 500, personal 100, gallery 100 | server (`AGENT_CAPS`)           |

A publish identical to the current version (same definition and same frozen tool manifest) is
refused as `unchanged`. A republish that only picks up a changed policy floor is allowed.

## Erasing an agent's versions (operator procedure)

Use this for a legal erasure request, such as a deactivated user's personal agents. It is a
manual, audited-by-hand operation. **There is no app path, and the retention and erasure policy is
still an open question (see `docs/ledger/KOBE-46.md`).**

Run it as a **superuser**, because RLS is forced on team tables, including for their owner. Do it
in **one transaction**, after a backup (`kobe backup`). Replace `:agent` with the agent's id.

1. **Decide what happens to pinned threads.** Either delete them (for user erasure, they belong
   to the same user), or keep them and clear their pin. A cleared pin runs on the install default
   agent from then on, and its history no longer names the version.
2. **Disable the immutability trigger** on the version table: `install_agent_versions` for
   personal and gallery agents, `team_agent_versions` for team agents. `ALTER TABLE` takes an
   ACCESS EXCLUSIVE lock, so do this in a quiet window.
3. **Remove the pins**, then **clear `current_version`**, **delete the versions** and **delete the
   agent**.
4. **Re-enable the trigger** and commit.
5. **Record the erasure** in your change log. `audit_log` is append-only and written by the app,
   so this manual step is not audited automatically.

```sql
BEGIN;
ALTER TABLE install_agent_versions DISABLE TRIGGER install_agent_versions_immutable;

-- Either delete the threads that pin the agent (entries, runs and events cascade) …
DELETE FROM threads WHERE install_agent_id = :'agent';
-- … or keep them and clear the pin:
-- UPDATE threads SET agent_scope = NULL, agent_id = NULL, agent_version = NULL
--   WHERE install_agent_id = :'agent';

UPDATE install_agents SET current_version = NULL WHERE id = :'agent';
DELETE FROM install_agent_versions WHERE agent_id = :'agent';
DELETE FROM install_agents WHERE id = :'agent';

ALTER TABLE install_agent_versions ENABLE TRIGGER install_agent_versions_immutable;
COMMIT;
```

For a team agent, use `team_agent_versions`, its trigger `team_agent_versions_immutable`,
`threads.team_agent_id` and `team_agents`, and add `AND team_id = :'team'` to every statement.

Deleting a whole team needs none of this. The team's cascade deletes its agents, versions and
threads, and the trigger lets cascades through.
