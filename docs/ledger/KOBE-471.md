# KOBE-471: Context viewer panel (web)

- **Status:** in review (not pushed; group branch `group-20-context-viewer`, after KOBE-470)
- **Spec:** `docs/specs/context-viewer.md`; route contract `packages/protocol/src/context-viewer.ts`

## What

- `lib/chat/context-viewer.ts`: reads `GET /v1/threads/{id}/context` with raw `fetch` and validates
  the body against the protocol schemas (wire casing, no camelizing); error text is always the
  contract's fixed message for the code. Gauge model (tool calls + results share one kind), rows,
  search, windowing, wake backoff (2 s floor ×1.5, 10 s cap, gives up after 3 min: ≤ 30/min).
- `components/shell/context-viewer.tsx` (+ `context-text.tsx`, `context-stack.tsx`, CSS module):
  reuses `WorkspacePanel` (modal, Escape, focus back to the gauge), rendered by `ContextViewerHost`
  beside the workspace grid as the Threads panel is (createPortal is reserved for shell slots);
  `PanelId` gained `context-viewer` (no route). Text: fixed 20 px rows, windowed, long lines wrapped
  at 160 columns, plain text only. Gauge: `--kobe-ctx-*` tokens (Okabe-Ito/Tol, light + dark) plus
  stripes/dots patterns; legend rows are the keyboard path (segments are mouse-only).
- Gauge: owner threads only (`summary.readOnly !== true`) get click/Enter/Space +
  `aria-haspopup="dialog"`; it stays a `meter` (no button wrapper, which would hide the role).
- `e2e/browser/tests/support/csp.ts` copied verbatim from main (KOBE-469) so the merge is clean.

## Gaps

- A search match split across a 160-column wrap is not found.
- Gate1 spec `e2e/browser/tests/context-viewer.spec.ts` not run here.
