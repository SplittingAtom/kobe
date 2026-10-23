# KOBE-490: Items an MCP app inserts into the composer show as typed chips

- **Status:** committed on `kobe-490-app-item-chips` (not pushed; no PR)
- **Branch / worktree:** `kobe-490-app-item-chips` in `../Kobe-wt490`
- **Depends on:** KOBE-439 (ui/message), KOBE-460 (rail picker). Catalyst side separate.

## Plan

Bridge parses `resource_link` blocks of `ui/message` → item chips per composer draft
(`session.appItems`) → the send carries `references` → the server appends one fixed line to the
run input → history parses the line back into chips.

## Decisions

- **No migration.** References travel as a strict protocol field (`references`, at most 20
  `{name, kind}`, unique, names without backticks/control characters, kind `[a-z][a-z0-9-]{0,31}`)
  and the server writes them into the stored message as one fixed trailing line
  ``\n\nReferenced: `a` (table), `b` (view)`` (`packages/protocol/src/item-references.ts`), the
  same pattern as the KOBE-451 skill line. The line is what the model sees, and the chat parses it
  back, so the sent message shows chips after reload. Order: skill line, member text, references
  line; app context stays in front.
- The uri, item title and app name stay in the browser (chip de-duplication, hover, accessible
  name); the sent chips show kind and name only.
- Unknown or missing `_meta["io.kobe/item-kind"]` → kind `item` (generic Box icon).
- A message with at least one valid link inserts no text (chips replace it). Links all invalid →
  the text goes in as before; nothing usable → error to the app plus a note in the chip row.
- Queued-message edits keep the references line (like app context and the skill line).
  `memberText` (titles, cards) drops the line.
- Not refused: member text that ends with a references-looking line (it only renders as chips of
  the member's own text; no trust boundary). Editing a sent message keeps the line in the text.
- Chips need some typed text to send (an empty composer still cannot send).
- No Enter gate for chips (they never move the focus and carry no free text).

## Review fixes (Opus review)

- MEDIUM-1: names capped at 200; default-ignorable code points (variation selectors, fillers)
  refused besides Cf; the chip hover shows the exact name sent (the app's link title is no longer
  kept).
- MEDIUM-2: queued edit strips any references line from the new text before re-appending
  (idempotent); the queue chip and editor show the member's text only.
- LOW-3: kinds outside the vocabulary become `item` (protocol `ITEM_KINDS`, `itemKindOf`; the
  server refuses others).
- LOW-4: the projection takes the line out of the text (`meta.references`); edit shows the
  references as removable chips and sends them as `references`; regenerate and regenerate-with
  send them again.

## Open questions (for Chris or the coordinator)

- Protocol contract change inside a feature PR (`references` on the submit body), as the brief
  allowed; split out if the contract rule should apply.
- Should the sent chip also name the app ("from Lakehouse Picker")? Not stored today.

## Evidence (acceptance criteria → test or command output)

- ac-1: `apps/web/lib/apps/app-items.test.ts` (validation, schemes, bounds, de-dup, store),
  `lib/apps/host-bridge.test.ts` "passes ui/message resource_links as items".
- ac-2: `components/apps/app-item-chips.test.tsx` (icons table/view/generic, accessible names).
- ac-3: `app-item-chips.test.tsx` (send payload, removal, history chips);
  `services/server/src/item-references.db.test.ts` (run input, queued edit, bounds);
  `packages/protocol/src/item-references.test.ts`.
- ac-4: existing KOBE-439 tests unchanged in behaviour (`app-context.test.tsx`, host-bridge).
- ac-5: `e2e/browser/tests/app-item-chips.spec.ts` with the fake MCP explorer's new
  "Use as item" button (`e2e/lib/fake-mcp.js`); added to `e2e/gate-apps.sh` SPECS. Not run here.
