# KOBE-432: Companion spec — MCP Apps host (Catalyst Lakehouse Explorer in the Workspace Rail)

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

Group G10, step 2. A spec, not code.

- **Spec:** `docs/specs/mcp-apps-host.md` (v0.1, 2026-10-19). Posted to Hadron as spec
  `7119888c-0058-419c-b6df-37ae09687433`, status **review** (pending Chris; not approved by the
  agent). It links Catalyst spec `0612ef17-bc24-40e4-a40d-c1bba08ca2ce` in its description (no
  cross-project link API).
- **Source contract:** CatalystPlatform `docs/mcp/SPEC.md` §8 (read only; commit a46cd29), plus
  M6, M10–M13 and the §5 app allowlist. Kobe decisions checked: D3, D9, D10, D25, D27, D29, D31,
  D32, and CE2/5/6/8/13.
- **Key decisions:**
  - Only `ui://` templates are in scope, as a D27 amendment (Q1).
  - The frame is an opaque-origin `srcdoc` iframe with `allow-scripts` only and an injected
    restrictive CSP. Declared CSP domains are ignored.
  - Messages are checked by `event.source` and validated with zod, under a method allowlist.
  - The browser principal has no run, so it is read-only, decided at `app_bridge` and audited as
    `mcp.app_call`.
  - Templates are pinned by Kobe's own SHA-256 via mcp-proxy's probe and served as JSON only.
  - `ui/message` inserts into the composer and never sends. `update-model-context` becomes a
    visible chip, sent as a fenced untrusted block.
  - Open-link and download are denied.
- **Licences checked (npm, 2026-10-19):** ext-apps 2.0.3 MIT; @modelcontextprotocol/core and
  client 2.3.1 Apache-2.0; @standard-schema/spec MIT. No assistant-ui MCP Apps renderer is
  published.
- **Proposed tickets (not filed):** MA-1 pin templates · MA-2 template review · MA-3 visibility ·
  MA-4 browser principal and app calls · MA-5 bridge and frame (with the AppBridge spike) · MA-6
  rail Apps and the artifact tab · MA-7 composer and model context · MA-8 the Kobe Explorer Gate.
- **Questions for Chris:** Q1–Q6 in spec §12.

## v0.2 (2026-10-19, Chris): the conversation is the main surface

- **MA3 rewritten.** Apps render in tool cards. The rail is a launcher that inserts an app card.
  The artifact column is only "expand".
- **MA10 (ticket MA-9), new.**
  - mcp-proxy captures the full upstream result and stores it in `thread_app_results`, a team
    table with RLS (inline up to 256 KiB, S3 up to 4 MiB).
  - `tool.result` gains an `app` marker (protocol PR first).
  - Reload rebuilds the app from the stored result.
  - Text fallbacks: drift, no access, break-glass, visibility without `"app"`, too large.
  - Retention, legal hold and fork cover the rows; exports are text only.
  - Performance: 360 px default height, Expand, lazy frames, at most 3 live frames per thread.
- **MA11, new (Chris decided the rail inserts an app card).**
  - The card is an `app_card` thread entry with no run.
  - It is mirrored to Pi as a `custom_message`, so the model sees fenced untrusted text.
  - With no current thread, a new thread starts.
  - During an active run the launch is **queued** (D17); refusing was rejected.
- **Threat model:** T11 (results come from the upstream, not the sandbox), T12 (each viewer acts
  as themselves), T13 (frame limits), T14 (only the card's text enters context).
- **Ticket order:** MA-1..5 → MA-9 → MA-7 → MA-6 → MA-8. The gate proves the in-conversation path
  first.
- **Questions:** Q2 became Q2a–c. Q7 (shared-thread viewers) is new.
- Hadron spec 7119888c: description, architecture and goals patched; it stays in **review**.
