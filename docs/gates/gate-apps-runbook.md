# Runbook: the Kobe Explorer Gate on the gate install (KOBE-441)

For the coordinator. Part (b) of `docs/gates/gate-apps.md`: Catalyst's Lakehouse Explorer on the
gate install, a real model and real Pi. Host names, accounts, keys and the deploy commands are in
your local notes (`CLAUDE.local.md`: the gate install, image import and pinning, the Playwright
container, the Catalyst connector); nothing here names them. Every step says what to record.

## 0. Before

- [ ] The group's PR (MCP Apps, `group-ma-apps`) is on main, and its migrations are renumbered
      (`db:rebase`).
- [ ] Images are built and imported to every node and pinned (local notes: "Image import check",
      "Pin imported images"); six images, all with the same `local-<sha12>` tag.
- [ ] The chart upgrade uses saved values with `--reset-values` (never `--reuse-values`). The
      migrations run on the server's start; check the server log says they did.
- [ ] Catalyst's MCP server is its Go rebuild with MCP Apps (Catalyst spec `0612ef17`, M24 done).

## 1. Pin and approve the template (site admin)

1. Site console → Connectors → `catalyst`: **Probe and pin** (or wait for the refresh).
2. The review lists `ui://catalyst/lakehouse-explorer` as new: check the hash and size, the
   declared `_meta.ui` (no `csp` domains), read the escaped source, open the **preview** (the
   bridge is stubbed: its calls fail), then **Approve**.
3. Record: a screenshot of the review, and the audit row:
   `SELECT action, target FROM audit_log WHERE action IN ('mcp.connector.pinned','mcp.connector.reapproved') ORDER BY seq DESC LIMIT 2;`
4. The team's exposure of `catalyst` includes `open_lakehouse_explorer` (Team console →
   Connectors), and the app-visible tools are read-only (Catalyst's §5 allowlist).

## 2. The member

- [ ] The test member (local notes: the second test member, or the owner) has their own Catalyst
      key at My connector keys, or the site key is set.
- [ ] Their rail shows **Apps → Lakehouse Explorer** (and, signed in as a member without a key,
      "Add your key … Catalyst" instead). Screenshot both.

## 3. The browser checks (Playwright container, as for the gate1 browser check)

From `e2e/browser` in the container, with the member's credentials from your local notes:

```bash
npm ci && npx playwright install chromium firefox webkit
KOBE_BASE_URL=<the gate install's URL> KOBE_USER=<member> KOBE_PW=<password> \
KOBE_APPS_CONNECTOR=catalyst \
KOBE_APPS_OPEN="Open the lakehouse explorer." \
KOBE_APPS_PATH="<catalog>,<namespace>,<table>" \
KOBE_APPS_ITEM_ROLE=treeitem \
KOBE_APPS_USE_TEXT='Use table `<catalog>.<namespace>.<table>`' \
KOBE_APPS_SECRET=<the member's Catalyst key> \
KOBE_REQUIRE_APP=1 KOBE_ALL_BROWSERS=1 \
KOBE_BROWSER_RESULTS=results.json \
  npx playwright test gate-apps/explorer.spec.ts app-frame.spec.ts
```

- `KOBE_APPS_PATH`: the names of the tree items to click, as Catalyst shows them, down to a small
  table. `KOBE_APPS_ITEM_ROLE`: the ARIA role of those items in Catalyst's tree (open the app once
  and check with the browser's accessibility tree; `treeitem`, else `button`).
  `KOBE_APPS_USE_LABEL` if Catalyst's button is not named "Use in chat".
- The probes test skips (`KOBE_APPS_PROBES` is for the k3d test app).
- The rail picker (KOBE-460): `gate-apps/picker.spec.ts` with `KOBE_APPS_CONNECTOR` set to the
  connector that offers "Lakehouse Picker" (`KOBE_APPS_PICKER` names another title),
  `KOBE_APPS_PICKER_PATH` (default `KOBE_APPS_PATH`), `KOBE_APPS_PICKER_USE_LABEL` if a button
  follows the table, and `KOBE_APPS_PICKER_TEXT` (what the composer then contains; default the
  table's name). It skips where the member has no live picker (the reason says whether
  `KOBE_APPS_CONNECTOR` was unset), and leaves the choice at None. A skip is not a pass: check
  `results.json` reports its three tests as run, with no skips, before marking it green.
- Keep `results.json`, `playwright-report/` and `test-results/` (traces, screenshots).

The spec asserts, in this order: the model's `open_lakehouse_explorer` call renders the tree in
its tool card and the card has the app (Pi's arguments matched); one click makes an app call; the
table gives the chip; "Use in chat" inserts the text, marked, without sending; Confirm and Enter
send it with the fenced `<app-context source="connector:catalyst" untrusted="true">` block in the
run's input; a reload rebuilds the tree with no app call; Expand and back. Then from the rail: a
new thread with the app card and no run, and a question about it that runs; a launch during a
long run waits as a chip and goes in after it. Last: the member's key is in no answer the browser
received. `app-frame.spec.ts` runs in Chromium, Firefox and WebKit: record the `webrtc` annotation
per browser (the spec's §3 residual risk).

## 4. By hand, with screenshots

1. **In the conversation:** "Open the lakehouse explorer" → the tree in the tool card. Select a
   table: the schema and preview show, and the chip "Context from Lakehouse Explorer: …" appears.
   "Use in chat" puts `` Use table `c.n.t` `` in the composer with "From Lakehouse Explorer"; Enter
   does nothing until you edit or Confirm. Send: the answer uses the table.
2. **Reload:** the tree is rebuilt.
3. **From the rail:** Lakehouse Explorer from the new-thread view → a new thread with the card, no
   run. Ask "Which tables did the explorer list?": the answer refers to the card.
4. **During a run:** start a long answer, click the app in the rail → the chip "App: Lakehouse
   Explorer (waits for the run)"; the card appears after the answer.
5. **Negative:** sign in as a member without a Catalyst key: no rail app, "Add your key", and a
   shared thread's card is text ("Connect catalyst to use this app.").

## 5. Evidence queries (as the database owner, in the gate install's database)

```sql
-- every app call of the run, with the member and the decision (never arguments or results)
SELECT created_at, target->>'userId' AS user_id, target->>'tool' AS tool,
       target->>'decision' AS decision, target->>'reason' AS reason
  FROM audit_log WHERE action = 'mcp.app_call' ORDER BY seq DESC LIMIT 20;
-- the threads' app results: claimed tool calls and app cards
SELECT thread_id, tool, tool_call_id IS NOT NULL AS from_model, entry_id, storage, bytes, queued_at
  FROM thread_app_results ORDER BY created_at DESC LIMIT 10;
-- the conversation's entries around the card (app cards are ka- ids)
SELECT seq, entry_id, parent_id, type, payload->>'customType' AS custom
  FROM thread_entries WHERE thread_id = '<the rail thread>' ORDER BY seq;
-- the run's input carries the fenced block
SELECT left(input, 200) FROM runs WHERE thread_id = '<the conversation thread>' ORDER BY created_at;
-- dropped waiting cards, if any
SELECT target FROM audit_log WHERE action = 'mcp.app_card_dropped' ORDER BY seq DESC LIMIT 5;
```

## 6. Record and close

- Fill the "Gate install" row of `docs/gates/gate-apps.md` (date, result, where the screenshots,
  `results.json` and query output are kept; no host names).
- File any failure as a ticket; a failing check stays.
- KOBE-441 and KOBE-432 ac-2 close with Catalyst M24 (Catalyst's own gate).
