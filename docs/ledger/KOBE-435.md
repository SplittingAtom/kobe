# KOBE-435: MA-3 Visibility (server, proxy)

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

Group MCP Apps (`group-ma-apps`), after KOBE-434. Spec `docs/specs/mcp-apps-host.md` MA6.

## What changed

- **Pinned** `_meta.ui.visibility` (`packages/db` `pinnedToolUiSchema`: `ui` now has optional
  `resource_uri` and optional `visibility: ("app"|"model")[]`). `pin.ts` normalizes it: only
  known values, de-duplicated and sorted. It is stored only when it differs from the default
  `["model", "app"]`, so a server that spells out the default does not drift, and tools without
  `_meta.ui` keep their G10 hash. An array with nothing Kobe knows becomes `[]` (visible to
  neither). `ui` is part of the tool hash, so **a visibility change drifts (ac-2)**, and
  approval takes the new value.
- **`services/server/src/connectors/visibility.ts`**: `modelVisible` and `appVisible` (MA-4 will
  use `appVisible`).
- **Not offered to Pi (ac-1)**: `exposedTools` (`mcp/catalog.ts`) drops tools without `"model"`.
  It feeds Pi's run catalog (`runs/run-mcp.ts`, Orbit), the proxy's `tools/list` (server
  `mcp/service.ts`) and the exposure check of `decideMcpCall`. `decideMcpCall` also refuses an
  app-only tool explicitly with `unknown_tool` ("offered only to apps") before the exposure
  check, so a sandbox naming it gets the same answer as for a tool that does not exist.
- The proxy needs no change: its `tools/list` and `tools/call` come from the server.
- The team admin's tool list (`team-store.ts`) still shows app-only tools, so a `custom`
  exposure can tick them for apps (MA-4).

## Tests

- `pin.test.ts` "visibility": normalization, default omitted (hash equals the G10 hash),
  different hashes per visibility.
- `drift.test.ts` "visibility changes drift (ac-2)": both directions; approval takes the new
  value.
- `runs/run-mcp.test.ts` "app-only tools (ac-1)": Pi's catalog keeps `both` and `model_only`
  and drops `app_only` and `[]`.
- `mcp.db.test.ts`: an exposed app-only tool is not in the proxy's `tools/list`, and a call to it
  is denied `unknown_tool`.
- db `ui-resources.test.ts`: the schema accepts visibility and refuses unknown values.

## Review fixes (review-ma2-3: M3, L3, L4)

- **M3 (rollout and rollback):** the server's allow carries `tool.model_visible: true`. When an
  allow lacks it (a previous-release server pod), the new proxy runs the upstream's `tools/list`
  in the same session and refuses (`not_offered`, before `tools/call`) a tool that is not
  model-visible by the same rules, or that the upstream no longer lists (`visibility.ts`,
  `upstream.ts` `checkModelVisible`). Tests are in `mcp.test.ts` (old-server allow).
  `docs/install.md` documents the rollout (any mix of pods is safe) and the rollback (both old:
  app-only tools are exposed again, so disable those connectors first).
- **L4:** a present but non-array visibility pins as `["model"]` and is not rejected. The model
  keeps what it had before MCP Apps (any non-Apps host would offer the tool), apps get nothing
  new, and one malformed field does not fail the whole snapshot (which would stop the
  connector's refresh and drift checks). The proxy's check uses the same rule.
- **L3 accepted (coordinator):** the policy engine ignores visibility. The catalog, the proxy's
  `tools/list`, `decideMcpCall` and the proxy's own check enforce it.

## Notes and questions

- The policy engine's exposure gate (`policy/gates.ts`) does not know visibility. A dedicated
  deny code would be a `packages/protocol` change (its own PR). The server's `decideMcpCall` and
  the catalog already make an app-only tool unreachable for Pi. Should a gate code be added
  with MA-4's protocol PR?
- The legacy adoption (KOBE-433 NEW-1, pin_version 1 only) also adopts a declared visibility
  once. That can only narrow what Pi or apps see.
