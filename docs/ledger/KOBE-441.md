# KOBE-441: MA-8 The Kobe Explorer Gate (e2e, docs)

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

Group MCP Apps (`group-ma-apps`), after KOBE-440. Spec `docs/specs/mcp-apps-host.md` §11.
Nothing pushed; Hadron untouched. **Not run yet**: k3d runs in CI (shard `gate-apps`) once the
group's PR runs there; the gate install is the coordinator's (runbook below).

## What was built

- `e2e/lib/fake-mcp.js`: `FAKE_MCP_APPS=1` makes the fake server an MCP Apps server (off by
  default, so `run.sh` and `gate2.sh` are unchanged): `open_explorer` (`_meta.ui` →
  `ui://e2e/explorer`, `depth` integer with a default), `list_items` (app-only), `describe_item`,
  `create_thing` (write); `resources/list|read`; a ~4.5 KB test app (ext-apps over postMessage:
  tree, chip, "Use in chat", probes for fetch out, `ui/open-link`, the write tool); `GET /_drift`
  and `GET /_calls`. Driven in Chromium against a stand-in host here: renders, expands (one call
  each), selects (context), inserts `` Use table `c.n.t` ``, all three probes fail.
- `e2e/gate-apps.sh` + `e2e/gate-apps/client.mjs`: fixtures (team `gate-apps-a`, a team admin with
  a key, a member without), the fake server and the proxy allow-list (chart upgrade with saved
  values), connectors `e2e-apps` and `e2e-apps-key` pinned and approved through the API, then the
  parts `setup`, `args` (real Pi: `{"depth":"5"}` and `{}` both get the app marker; prints
  `pi_input` and the upstream's `CALL`), `bridge`, `forged`, `rail`, `queue`, `nokey`, the browser
  specs, then `drift` (a real refresh) and `export`. Verdict `Kobe Explorer Gate (k3d): proven`;
  `e2e/gate-verdicts.sh` accepts it.
- `e2e/browser/tests/gate-apps/explorer.spec.ts`: one spec for k3d and the gate install
  (`KOBE_APPS_*`), conversation first, then the rail, the probes, and no credential in any
  answer the browser saw (frame documents included). `app-frame.spec.ts` runs with
  `KOBE_REQUIRE_APP=1` and `KOBE_APP_ID`.
- CI: shard `gate-apps` in `.github/workflows/e2e.yml` (Node and Chromium, Playwright artifacts on
  failure).
- Docs: `docs/gates/gate-apps.md` (each check → §11; evidence table to fill),
  `docs/gates/gate-apps-runbook.md` (the coordinator's gate-install run: pin and approve, the
  member, the Playwright container command with `KOBE_ALL_BROWSERS=1`, by-hand steps, evidence
  SQL; no host names), `e2e/browser/README.md`.

## Checked here

`bash -n`; the combined client parses (`node --check`); the browser specs typecheck and list
(`playwright test --list`); `actionlint` on the workflow; prettier. Not run: anything needing a
cluster (no local Docker engine; k3d is CI's).

## For the first CI run (likely to need a look)

- The key connector's pin without the owner's key (the fake server never asks for one).
- The fake model's `history?` echo with Pi's custom message (the card) before the prompt; if Pi's
  OpenAI conversion merges the two user messages, the echo path differs but still contains the card.
- The queued launch's timing (`kobe-long-answer=400`, 6 s wait before the launch).
- Catalyst's tree roles for the gate install (`KOBE_APPS_ITEM_ROLE`, runbook §3).
