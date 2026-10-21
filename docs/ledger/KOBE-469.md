# KOBE-469: File editor unstyled on gate1: CodeMirror style tags blocked by the nonce CSP

- **Status:** in review (group branch `group-19-editor-csp`, no PR yet)
- **Worktree:** `../Kobe-wt469`

## Cause and fix

The page CSP allows only `'self'` and nonced `<style>`; CodeMirror (style-mod) and
`@codemirror/merge` inject `<style>` without a nonce, so all their styles were dropped (gutter
above the text, no diff colours). The editor now sets `EditorView.cspNonce` (one view serves both
the plain editor and the unified merge view). No CSP change.

## Decisions

- **Nonce from the DOM, not a layout context** (`lib/security/csp-nonce.ts`): the `nonce`
  property of a script Next nonced is exactly the nonce the document's CSP (fixed at first load)
  accepts. A layout prop would carry the nonce of whichever request last rendered the layout (a
  refresh re-renders it with a fresh one, which the document refuses) and would put the nonce in
  the RSC payload. The property is read, not the attribute (browsers hide the attribute).

## Other style injectors in apps/web

- **Radix (`react-remove-scroll` -> `react-style-singleton`)** adds a `<style>` for the scroll
  lock when a modal overlay opens, nonced only via `get-nonce`/`__webpack_nonce__`, which Next
  does not set. Fixed: `components/security/style-nonce.tsx` (first in the root layout's body)
  calls `setNonce` with the document nonce. `get-nonce` is a direct dependency pinned to 1.0.1,
  the only version in the lockfile (`pnpm why`), so it is the copy react-style-singleton uses.
- **mermaid** puts `<style>` in its scratch SVG during `render`; the result is shown as an
  `<img>` data URL (own document, outside the page CSP), so only measurement may differ.

## Verification

- Unit: `components/files/code-editor.test.tsx` (nonce read; facet on both views);
  `components/security/style-nonce.test.tsx` (a modal Radix dialog's injected style is nonced).
- Browser: `command-palette.spec.ts` asserts no style-src violation around the modal palette.
- Browser: `e2e/browser/tests/file-editor.spec.ts` checks gutter beside text, coloured
  added/deleted lines, no style-src violation (not run on gate1 by this ticket).
