# KOBE-207: B3: Streaming arrival fade and reduced-motion fallback

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (PR pending)
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
  ac-2 and "no per-character reveal"). Instead `components/chat/arriving-words.tsx` splits the text
  into word spans during the render that already happens per text delta: a rehype step for
  Markdown (react-markdown keys siblings `span-0`, `span-1`, ..., so arrived words keep their
  element and only new words mount) and `ArrivingWords` for reasoning.
- **Only the part being written** (`status.type === "running"`, which changes once per part) gets
  spans and `data-kobe-arrive="running"`. Finished parts and history render plain text, so no
  extra DOM in long threads and no fade on load. When a part finishes, words still mid-fade snap to
  the text colour (at most 600 ms of tail).
- **Pinned gating via a variable, not the animation.** `--kobe-arrive-tint` is the accent under
  `[data-kobe-follow="pinned"]`, else `currentColor` (fade invisible). Toggling `animation` itself
  would restart the fade on every word of the part when the member re-pins.
- **Tint:** `--admin-accent` (the chat's accent, #2449c7 / #8fa8ff dark), falling back to
  `--primary`; the shadcn `--accent` token is a near-white background colour.
- **Reduced motion:** no animation; a 2 px bar left of the last block of the part being written,
  drawn with two box-shadows (background gap, then tint), so nothing reflows and the code block's
  `overflow: hidden` does not clip it. Also only while pinned.
- **Tests that found streaming text by `findByText`** now use `streamed(text)` from
  `components/chat/testing.tsx` (innermost element holding the text across spans).

## Open questions (for Chris or the coordinator)

- No browser check on gate1 yet (no Playwright in the repo); the fade/bar look is unverified in a
  real browser. Worth a glance at the next gate1 deploy.

## Evidence (acceptance criteria → test or command output)

- **ac-1** `apps/web/components/chat/arrival-fade.test.tsx`: "wraps each word of a streaming part",
  "streaming answer and reasoning words arrive as spans; tool output does not", "animates arriving
  words over 600 ms", "under reduced motion: no fade, a static bar".
- **ac-2** same file, "costs no React renders per token over plain Markdown" (React `Profiler`:
  7 tokens give 8 renders with and without the fade) and "keeps arrived words' spans as text grows".
- **ac-3** same file, "tints only while the message list is pinned"; `scroll.test.tsx`, "arrival
  fade follows the pin" (`data-kobe-follow` unpinned when scrolled up, pinned after Jump to latest).
- `pnpm verify` green before push; CI on the PR.
