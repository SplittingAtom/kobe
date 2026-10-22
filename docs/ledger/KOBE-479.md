# KOBE-479: Web: blue (primary) buttons always have white text

- **Status:** in review (group 26)
- **Branch / worktree:** `group-26-blue-buttons` in `../Kobe-wt479`
- **Depends on:** none

## Plan

Find every blue fill, fix at the token, then the one-offs; guard with unit and browser checks.

## Decisions

- `--primary` is neutral (near-black / near-white), not blue; the one blue fill is the accent
  `--kobe-status-accent` (console primary buttons, links styled as them, accent badges, the
  notification count pill). Light was already white on `#2449c7`; dark was `#0a0a0a` on
  `#8fa8ff`. Dark now `#4263eb` with `#ffffff` (4.98:1; hover `/90` over dark surfaces is darker,
  so higher). The info notice's icon reads the same token: 3:1 or more on dark surfaces.
- `--admin-accent` (`#8fa8ff` dark) stays for link text and focus rings; it only fills
  textless things (resize handles, switch track).
- One-off: the chat's unlayered `.app a { color: var(--admin-accent) }` beats every utility, so a
  `<Button asChild><a>` in the chat would get blue text on its fill. It now skips
  `[data-slot="button"]` and `[data-slot="console-button"]`.
- No CSP change, no injected styles: the browser check reads colours via getComputedStyle and a
  canvas.

## Evidence

- ac-1, ac-2: `app/theme-css.test.ts` "blue fills carry white text with AA, at rest and on
  hover" (light, dark); `components/ui/blue-buttons.test.ts` (variants, every state, link rule).
- ac-3: those unit tests plus `e2e/browser/tests/blue-buttons.spec.ts` (chat, Threads panel,
  files rail, a console page, My Agents, Skills Workbench; light and dark; "blue" = within 30°
  of the accent token's hue with chroma ≥ 0.25). Run against gate1 after deploy.
