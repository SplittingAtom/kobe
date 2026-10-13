# KOBE-207: B3: Streaming arrival fade and reduced-motion fallback

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (PR #266)
- **Branch / worktree:** `kobe-207-arrival-fade` in `../Kobe-wt207`
- **Depends on:** KOBE-205 (merged). Phase B run now at Chris's request; the Gate 4 note does not block.

## Plan

Words of the part being written are `<span data-kobe-word>`; a CSS animation on those spans fades
each word from the accent tint over 600 ms when React mounts it. The message list exposes the
KOBE-205 follow state as `data-kobe-follow` so the CSS drops the tint while scrolled up.

## Decisions

- **Not assistant-ui's `useSmooth`.** assistant-ui 0.15's smooth streaming (`useSmooth`,
  `MessagePartPrimitive.Text smooth`) is a typewriter reveal that sets React state every animation
  frame and renders one text node, so it has no per-word spans and would add renders (against
  ac-2 and "no per-character reveal"). Instead `components/chat/arriving-words.tsx` splits text
  into word spans in the render that already happens per delta: a rehype step marks each Markdown
  text run with its source offset and `MarkdownWords` renders its words (no element of its own);
  `ArrivingWords` does the same for reasoning.
- **Keys are source offsets** (run start + offset in the run), not react-markdown's per-tag counter,
  so a word keeps its element across re-parses (closing backtick, `**`, setext heading) and words
  after a restructure are new elements. Words that move into a new parent (the text inside a
  just-closed `**`) remount and fade again: React cannot move DOM across parents.
- **Only words that arrive after mount get spans.** Text there when the Markdown mounted (history,
  a thread opened, reloaded or switched mid-run) renders plain and never fades; the length at mount
  is the only state. Side effect: a part's first delta, which mounts it, does not fade.
- **Spans stay when the part finishes** (stable DOM, selection kept); `data-kobe-arrive="running"`
  (part status, changes once per part) is what switches the fade on.
- **Code renders plain** (`pre`/`code` skipped): long code blocks add no spans per delta.
- **Pinned gating via a variable, not the animation.** `--kobe-arrive-tint` is the accent under
  `[data-kobe-follow="pinned"]`, else `currentColor` (fade invisible). Toggling `animation` itself
  would restart the fade on every word of the part when the member re-pins.
- **Tint:** `--admin-accent` (the chat's accent, #2449c7 / #8fa8ff dark), falling back to
  `--primary`; the shadcn `--accent` token is a near-white background colour.
- **Reduced motion:** no animation; an inset 2 px bar (`box-shadow: inset`) inside the last block of
  the part being written, only while pinned. Agent prose blocks (p, headings, lists) keep a constant
  0.5rem start padding under reduced motion so the bar never touches text and nothing reflows.
- **Tests that found streaming text by `findByText`** now use `streamed(text)` from
  `components/chat/testing.tsx` (innermost element holding the text across spans).

## Open questions (for Chris or the coordinator)

- No browser check on gate1 yet (no Playwright in the repo); the fade/bar look is unverified in a
  real browser. Worth a glance at the next gate1 deploy.

## Evidence (acceptance criteria → test or command output)

- **ac-1** `apps/web/components/chat/arrival-fade.test.tsx`: "wraps each word that arrives",
  "streaming answer and reasoning words arrive as spans; tool output does not", "leaves code blocks
  plain", backtick/bold/heading re-parse cases, "reopening mid-run shows what streamed so far plain",
  "animates arriving words over 600 ms", "under reduced motion: no fade, a static inset bar".
- Review round 1 (coordinator, 6 findings): all fixed as above.
- **ac-2** same file, "costs no React renders per token over plain Markdown" (React `Profiler`:
  7 tokens give 8 renders with and without the fade) and "keeps arrived words' spans as text grows".
- **ac-3** same file, "tints only while the message list is pinned"; `scroll.test.tsx`, "arrival
  fade follows the pin" (`data-kobe-follow` unpinned when scrolled up, pinned after Jump to latest).
- `pnpm verify` green before push; CI on the PR.
