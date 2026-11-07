# KOBE-551: Composer: drop a Lakehouse Picker item as the ui/message insert

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** merged (PR #461, main 02c12b56)
- **Branch / worktree:** `kobe-551-lakehouse-drop` in `../Kobe-wt551`
- **Depends on:** KOBE-490 (item chips), KOBE-374 (Files-row drop), KOBE-460 (rail picker)

## Plan

- `apps/web/lib/apps/lakehouse-drop.ts`: the drag type, `carriesLakehouseItem` (type name only,
  hover), `lakehouseItemContent(json)` (validation; returns the click's `ui/message` content).
- `apps/web/lib/apps/host-bridge.ts`: `appMessageOf(content)` extracted from `case "ui/message"`;
  the bridge and the drop both call it. `components/apps/use-app-composer.ts`:
  `applyAppMessage(session, draft, message, from)` extracted from `onMessage`; both call it.
- `components/chat/composer-mention-drop.ts`: the Catalyst branch first in `over`/`drop`
  (writable only), hover state `data-mention-drop="item"` (same tokens as the file hover,
  `composer.module.css`, forced-colours too), hint "Drop to insert this item", refusal notice
  under the composer.

## Decisions

- **Parity with the click** (coordinator decision 2026-11-07, answering open question 1): a drop
  ends in exactly the composer state a picker click produces today: the chip (from "Lakehouse
  Picker") and `references` on send, no backticked identifier in the textarea, focus and caret
  untouched. Chris's requirement text about the caret predates KOBE-490 (links replace the
  text); naming the item twice in the sent message would be a visible defect. Both paths go
  through `appMessageOf` + `applyAppMessage`. (The first push also inserted the text; removed.)
- Kind and segments must agree: catalog = 1 segment, namespace = 2, table/view = 3; nested
  namespaces (dots) are refused by the segment rule anyway. Raw JSON over 8 KiB is refused before
  parsing. A name over 200 chars passes the 511 cap but is dropped by the resource_link rules
  (`ITEM_REFERENCE_NAME_MAX`), so it is refused too.
- The chip's "from" is the constant "Lakehouse Picker" (a drag names no app; that is the
  picker's title on the gate install).
- A drop with the chip row full (20) is refused with "A message can reference at most 20 items."
  and inserts nothing.
- A Catalyst drop is always `preventDefault`ed (valid or not), so the textarea's own
  `text/plain` insertion never happens (no double insert, no fallback).
- Read-only and Trash composers render no drop panel; the hook also gates on `writable`.

## Open questions (for Chris or the coordinator)

- none (question 1 decided, see Decisions)

## Follow-ups (review of PR #461, low)

- No unit test for the `LAKEHOUSE_DROP_FULL` path (`composer-mention-drop.ts`).
- The exact 511 / 2047 bounds are untested (only values well over them).
- No test for kind `table` with a catalog and namespace but no name.
- A real cross-frame drag from the picker needs the Catalyst-side build; until then the browser
  spec synthesizes the DataTransfer.

## Evidence (acceptance criteria → test or command output)

- ac-1: `apps/web/components/chat/composer-lakehouse-drop.test.tsx` (hover + taken dragover,
  plain-text drag untouched); `composer-mention-drop.test.tsx` unchanged and green;
  `composer-outline.test.tsx` covers the `item` cue.
- ac-2: `apps/web/lib/apps/lakehouse-drop.test.ts` (validation table) and the component test's
  refusals (notice, nothing inserted, no chip).
- ac-3: `lakehouse-drop.test.ts` "a drop is a click" (bridge `ui/message` vs drop: same
  `AppMessage`, no text, same chip store snapshot); component test (chip, text and caret
  untouched, `references`).
- ac-4: component test (shared reader, Trash: no drop target, drop not taken).
- ac-5: `pnpm verify` green; CI on the PR.
- ac-6: `docs/specs/mcp-apps-host.md` §8, "Host extension: native drags from an app frame".
- ac-7: `e2e/browser/tests/lakehouse-drop.spec.ts` (synthesized DataTransfer with both types;
  chromium, and firefox with `KOBE_ALL_BROWSERS=1 --project firefox`). Not run here (no browser
  libraries on the VM, gate1 not on this code): the coordinator runs it after deploy.
- ac-7: gate1 `local-02c12b56b386` (Helm upgrade with `--reset-values`, reconcile failed:0). The
  `lakehouse-drop` spec in the Playwright 1.55 container on compute2 against gate1, with the
  synthesized DataTransfer: `[chromium]` and `[firefox]` both passed (3 passed incl. setup,
  45.8 s). A drag from the real picker frame awaits the Catalyst-side build.
