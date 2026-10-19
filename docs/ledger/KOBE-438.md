# KOBE-438: MA-9 Apps in the conversation (proxy, server, db, protocol, web)

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

**Renumbered by db:rebase (2026-10-19, on main 05a92778):** the generated migrations are one, 0153_mcp_apps (old 0152, 0153, 0155, 0156, 0157, 0159, 0162); the custom ones keep their SQL: 0154 approved backfill (old 0154), 0155 RLS and legal hold (old 0158), 0156 run-end discard (old 0160), 0157 hold lock first (old 0161). Numbers below are the new ones.

Group MCP Apps (`group-ma-apps`), after KOBE-437. Spec `docs/specs/mcp-apps-host.md` MA10 (and
MA11's `entry_id` for MA-6). Nothing pushed; Hadron untouched.

## Commits (in order)

- `92f6279c` protocol: `tool.result.app {connector_id, app_id, template_sha256, result_ref}`
  (`toolResultAppSchema`). **Its own commit, for its own PR** (docs/parallel-work.md).
- `8228e7f5` db: generated migration **0153** `thread_app_results` (plus the probe fixture and
  the upgrade test, staged with it).
- `64782746` db: custom migration **0155**: ENABLE + FORCE RLS, `team_isolation`, the
  artifacts-style legal-hold delete and truncate guards, and `(team_id, run_id) → runs ON DELETE
SET NULL (run_id)` (drizzle cannot name the column list). No `break_glass_read`: break-glass
  readers get the text card.
- `b3ad58b6` server; `ec3710f8` mcp-proxy; `954a4e0e` web; then docs and this ledger.

## The link problem, and the design

mcp-proxy cannot tell which of Pi's tool calls it serves: nothing sets
`_meta["kobe.dev/tool_call_id"]` (the server invents `mcp-proxy-<uuid>`). So:

1. **Capture ticket** (`apps/capture-ticket.ts`): when `decideMcpCall` allows a tool whose
   `ui.resource_uri` names a pinned, approved template (`servedTemplateHash`), the allow carries
   `app_capture.ticket`: HMAC (key derived from `authSecret` for this purpose) over team, user,
   sandbox, thread, run, connector, tool, Pi name, input digest, template URI and hash, and the
   app id; 5 minutes.
2. **Report** (`POST /internal/v1/mcp/connectors/:id/results {ticket, result}`, internal key
   and the sandbox's own token, 4 MiB + 16 KiB body): stored only when the ticket verifies and
   names exactly this sandbox, team, user and connector, the run is still active in the
   ticket's thread, and the result is not `isError`. The proxy awaits it **before** answering
   Pi; a failed report only means text.
3. **Store** (`apps/results-store.ts`): ≤ 256 KiB `inline`; ≤ 4 MiB `blob` at
   `<prefix>teams/<t>/threads/<th>/apps/<id>` (artifacts' order: queue the key, upload, row and
   unqueue in one transaction, delete on refusal); otherwise `too_large`. Stored bytes count in
   the team quota (`storageUsed` gains `thread_app_results`); over quota → `too_large`.
4. **Claim** (`apps/claim.ts`, in `RunIngest.#flush` before the append): for each MCP
   `tool.result` (not error), the call's input (this batch's `tool.call`, else `run_events`) is
   digested the same way (`inputDigest`); the oldest unclaimed row with the same run, Pi name and
   digest gets `tool_call_id` and `prompt_entry_id` (the run's `user_entry_id`), and the event
   gets the `app` marker. The marker is only ever the server's (the translator builds
   `tool.result`). Same tool + same input twice in one run: claimed in order (same data).
5. **Views** (`apps/thread-results.ts`, `GET /v1/threads/:id/app-results`, visible like the
   thread): per viewer, `app` or `text` with `too_large | template_changed | not_app_visible |
no_access` (T12: the viewer's own `memberApps`). `GET …/app-results/:ref` → `{result}` only
   when the viewer gets the app (409 `text_only`); JSON with `no-store`, `nosniff`,
   `default-src 'none'`; blobs via `readOffloadedJson` (thread tree only, capped, limited).
6. **Fork** (`apps/fork-results.ts`, `threads/fork.ts`): claimed rows whose prompt entry is on
   the copied path (and MA-6 entries on it) are copied with no run, placed by (prompt entry, tool
   call); blobs are server-side copied into the fork's tree before the transaction, like
   offloaded bodies. **Export** reads entries, artifacts and files only: text only (tested).
7. **Retention / legal hold:** rows cascade with the thread; `blob_ref` is in
   `BLOB_REF_COLUMNS` (thread tree), so the generic purge queues the objects; the guards refuse a
   held thread's deletes and TRUNCATE.

Schema rework (before review): 0153/0155 were regenerated once in this ticket (local only,
unpushed): the first draft's run FK cascaded, which would have deleted a fork's copies with
the source's purge. Rows are now placed by `(prompt_entry_id, tool_call_id)`.

## Web

- `components/apps/thread-apps.tsx` `ThreadAppsProvider` (inside `ThreadMarkersProvider`):
  reads the list on open, when a run ends, and when a live `tool.result` carries a marker;
  lookups by `approvalKey(prompt, toolCallId)` and, for the live run, `runToolKey`. Holds the
  live-frame slots (`lib/apps/live-slots.ts`: 3, LRU, `force` retires the least recent).
- `components/apps/tool-card-app.tsx` in `ToolCallCard` (MCP tools only): text reason line,
  or the app: IntersectionObserver within one viewport takes a slot, beyond three releases it;
  the stored result is read once; before a frame is removed, `AppFrameHandle.teardown()`
  (`ui/resource-teardown`, 500 ms); a torn-down card keeps its last height (`onHeight`); "Show
  app" when no slot; **Expand** → `ArtifactPanelApi.openApp` → a transient `app:<ref>` tab
  (`lib/apps/app-tabs.ts`; never written to storage, kept by `retainTabs`) rendering
  `AppFrame placement="expanded"` (≤ 4,000 px); the card says "Opened in the side column".
  Below 820 px the column is the sheet (existing behaviour of `openArtifact`).
- The frame route already requires `sha256`: a template re-approved since the capture is a
  `template_changed` text card, never different bytes.

## Acceptance criteria

- **ac-1** stored from mcp-proxy only, inline ≤ 256 KiB, S3 ≤ 4 MiB, else text; a forged
  report (no internal key, changed ticket, another sandbox, another connector, error result)
  stores nothing: `app-results.db.test.ts` "capture"; proxy `mcp.test.ts` "MCP Apps result
  capture".
- **ac-2** the card renders the template with that result; the app's calls are MA-4's (viewer,
  read-only, audited): `tool-card-app.test.tsx` (history and live run), `team-apps.db.test.ts`.
- **ac-3** reload reads the stored result (no `/calls`, no upstream); text with reasons for
  drift, visibility, no access: DB "gives text with the right reason", web "renders the app …
  and text". Break-glass: never served (no policy; the site reader is text only).
- **ac-4** a shared-thread viewer acts as themselves (DB test: member gets `no_access` once the
  team drops the connector; private thread 404); fork copies (inline and blob); export text
  only; legal hold and RLS (`thread-app-results-upgrade.db.test.ts`); probe suite covers the
  table (fixture in `probe-fixtures/conversations.ts`).
- **ac-5** 360 px default, ≤ 720 inline (MA-5 tests), lazy loading, 3 live, Show app, Expand
  and back: `tool-card-app.test.tsx`, `live-slots.test.ts`, `artifact-tabs.test.ts`.

## Tests run

db unit 598, probe 657, upgrade 4; server unit 2,112; server DB `app-results` (11), `mcp`,
`mcp-exposure`, `mcp-proxy-gate2`, `retention`, `retention-forks`, `skill-use`, `team-apps`,
`thread-fork`, `uploads`, `workspace-sync-team-quota`, `connector-template-review`; proxy 128;
web 2,028; typecheck, lint, format, `license:check`.

## Review fixes (review-ma9: MEDIUM-1, LOW-1..9), `39bce30f..`

- **MEDIUM-1:** migration **0156** (custom): an `AFTER UPDATE OF status` trigger on `runs`
  drops a run's unclaimed rows and queues their blobs (due now) when it leaves the active
  states, in every end state (upgrade test per state); held threads keep them. At most 20
  unclaimed rows per run (429 `too_many_unclaimed`).
- **LOW-1:** the claim is exact or nothing: with more than one pending candidate for (run, tool,
  digest), none is claimed (text). No "oldest row of the tool" fallback. (The proxy cannot carry
  a per-call nonce Pi would echo, so ambiguity falls back to text.)
- **LOW-2:** migration **0153** (generated): `input jsonb` (≤ 64 KiB). The report carries the
  input (digest must equal the ticket's); `GET …/:ref` answers `{input, result}`; the app's
  `tool-input` comes from there. Fork copies it.
- **LOW-3:** `FrameInstance` posts `ui/resource-teardown` in a layout cleanup (iframe still
  attached) on every removal; the card still awaits it before an inline removal.
- **LOW-4:** an expanded app keeps its card's slot; a forced retire closes its tab.
- **LOW-5:** `readAppResult` decides only its row; two blob reads per member per pod.
- **LOW-6:** `thread.purged` / `retention.purged` carry `appResults` (when non-zero); DB test
  purges a thread with a blob result and checks the queue and the count.
- **LOW-7:** a fork copies only results whose tool call is on its path, and only within the
  team's quota (else text).
- **LOW-8, LOW-9:** spec T11 and MA10 amended (ticket, exact claim, run-end cleanup, what a
  compromised sandbox can still do); the WebRTC note says what Chromium and WebKit do.
- MA-5 nit: the WebRTC guard follows a doctype even after leading comments (standards mode).

## Notes for review

- The claim relies on Pi passing an MCP tool's arguments unchanged (same canonical digest). The
  review's MA-8 check: a schema default and a coercible argument (`"5"` for an integer); a
  mismatch fails safe (text) and the row goes at run end.
- The protocol commit (`92f6279c`) is separate for its own PR; the coordinator decides whether
  it ships ahead of the group PR.
