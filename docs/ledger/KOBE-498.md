# KOBE-498: Theming T2: tokenize the web UI

- **Status:** done on the group branch (no push/PR, group rule 2026-10-15); review fixes 1–9 applied
- **Branch / worktree:** `kobe-498-tokenize-ui` in `../Kobe-wt498`
- **Depends on:** nothing. Plan: `docs/specs/theming.md` §5 (TH3), catalogue `docs/theming.md` (branch `theming-plan`)

## Plan

Tests first (`apps/web/app/theme-css.test.ts`), then `theme.css` tokens, `tailwind.css` mappings,
CSS modules and three TSX lines. Each token holds the literal it replaces, except where a decision
below accepts a change.

## Tokens added (`apps/web/app/theme.css`)

| Token                                    | Light                                                             | Dark      | Read by                                                                                                                                                          |
| ---------------------------------------- | ----------------------------------------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--kobe-brand-primary`                   | `#2449c7`                                                         | `#4263eb` | `--kobe-status-accent`                                                                                                                                           |
| `--kobe-brand-primary-hover`             | `color-mix(in oklab, var(--kobe-brand-primary) 90%, transparent)` | (follows) | console primary button hover (was `bg-status-accent/90`)                                                                                                         |
| `--kobe-brand-primary-fg`                | `#ffffff`                                                         | `#ffffff` | `--kobe-status-accent-fg`                                                                                                                                        |
| `--kobe-brand-link`                      | `#2449c7`                                                         | `#8fa8ff` | `--admin-accent`                                                                                                                                                 |
| `--kobe-brand-focus`                     | `#2449c7`                                                         | `#8fa8ff` | every focus outline: chat `.app`, console `[data-kobe-console] :focus-visible` and `FOCUS_RING` (`outline-brand-focus`), rail drop target, composer mention drop |
| `--admin-fg/-muted/-bg/-panel/-border`   | moved from `chat.module.css .app`, same mappings                  |           | rail, shell                                                                                                                                                      |
| `--admin-hover`                          | `rgb(127 127 127 / 12%)` (today's fallback)                       | same      | rail `.appRow:hover`                                                                                                                                             |
| `--kobe-font-sans`                       | `system-ui, sans-serif`                                           |           | chat root, Tailwind `font-sans`                                                                                                                                  |
| `--kobe-font-mono`                       | `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`        |           | chat code (2), context viewer, file editor, Tailwind `font-mono`                                                                                                 |
| `--kobe-brand-wordmark-size` / `-weight` | `1.125rem` / `600`                                                |           | `shell.module.css .wordmark`                                                                                                                                     |
| `--kobe-radius-sm/md/lg/xl`              | `0.25rem/0.375rem/0.5rem/0.75rem`                                 |           | modules, `rounded-sm..xl`                                                                                                                                        |
| `--kobe-radius-pill`                     | `9999px`                                                          |           | the modules' 999px pills only                                                                                                                                    |
| `--kobe-shadow-pop`                      | `0 4px 16px rgb(0 0 0 / 15%)`                                     | inherits  | chat menu, rail popover, new-build banner                                                                                                                        |
| `--kobe-shadow-drawer`                   | `0 8px 24px rgb(0 0 0 / 12%)`                                     | inherits  | rail drawer, shell popover, artifact column edge                                                                                                                 |
| `--kobe-shadow-panel`                    | `0 1.5rem 4rem rgb(0 0 0 / 25%)`                                  | inherits  | workspace panel                                                                                                                                                  |
| `--kobe-scrim`                           | `rgb(0 0 0 / 40%)`                                                | inherits  | rail drawer `0 0 0 100vmax …`                                                                                                                                    |
| `--kobe-ctx-pattern-stripe` / `-dot`     | `rgb(255 255 255 / 45%)` / `55%`                                  |           | context-viewer patterns (fixed)                                                                                                                                  |

Kept own values (catalogue default differs, existing wins): `--ring` (grey), `--kobe-composer-focus`.
Tailwind `@theme inline`: `--color-brand-*` (5), `--font-sans/-mono`, `--radius-sm..xl`. No shadow
mappings (no consumer); `--radius-full` stays Tailwind's.

## Literals replaced

- `border-radius`: 22× `0.375rem`, 11× `0.5rem`, 3× `0.25rem`, 1× `0.75rem`, 7× `999px`, 1× `0.1875rem`
  (legend swatch → `--kobe-radius-sm`), 2× in `chat-global.css`. Kept: `50%`, `0`, `inherit`.
- `font-family`: `chat.module.css` ×3, `context-viewer.module.css`, `code-editor.tsx`.
- `box-shadow`/scrim: the 8 `rgb(0 0 0 / …)` in chat, rail (3), shell (2), workspace-panel, banner.
- Fallbacks dropped: rail (4), icon-action (3), context-gauge (1).
- `markers.tsx`: `text-amber-700 dark:text-amber-400` → `text-status-attention`.

## Decisions

- Coordinator, 2026-10-29 (review):
  1. `rounded-full` keeps Tailwind's `calc(infinity * 1px)` for circles; `--kobe-radius-pill` only
     replaces the modules' literal 999px pills (identical pixels under 1998px short side, CSS
     Backgrounds 3 §5.5).
  2. Catalogue tokens only: banner → `--kobe-shadow-pop` (18% → 15%), artifact edge →
     `--kobe-shadow-drawer` (`-8px 0 24px` 16% → `0 8px 24px` 12%); one `--kobe-font-sans` and one
     `--kobe-font-mono` (the chat's code font moving to Menlo on macOS Chrome is accepted).
  3. Shadow/scrim tokens live on `:root` only; dark schemes inherit them until T4's presets.
  4. Legend swatch radius 3px → 4px (`--kobe-radius-sm`); no `calc()` branch in the guard.
  5. `--kobe-brand-primary-hover` is today's `/90` mix, used by the console primary button.
  6. Every focus outline reads `--kobe-brand-focus` (same values as `--admin-accent` today).
     The new-build banner's `--ring` outline and the handles' focus background stay as they are.
- `--admin-*` aliases on `:root`: every reader renders inside `.app` (portals use
  `chatPortalContainer()`), so values are unchanged there.
- Guard: TS/TSX scans read raw source; CSS comment stripping is for stylesheets only. Colour hits
  need a CSS-ish context (arbitrary `[…]` value, hex after `:` or inside `fn(`/`, `, a quoted 6/8-digit
  hex, or a colour function). Self-test strings are built from parts so Tailwind's source scan does
  not compile them. `bg-black`/`bg-white`/`text-white` (overlays, frames) are not hue-scale classes.

## Open questions (for Chris or the coordinator)

- Decision 2 also moves Tailwind `font-sans` (console layout, so every console page) from Tailwind's
  default stack (`… Roboto, "Noto Sans", Arial …`) to `system-ui, sans-serif`. On Linux CI, if the
  Playwright image has Roboto/Noto Sans or maps Arial to Liberation Sans, console text changes and
  `consoles.spec.ts` baselines will differ (ac-3); likewise `font-mono` loses Monaco/Liberation
  Mono/Courier New. Watch the first CI run; if it differs, baselines need regenerating or the old
  stacks restored.
- Markers' warn text: amber-700/400 → status attention (`#a14b05`/`#fbbf24`), as the ticket asked.
- The catalogue should add `--kobe-ctx-pattern-*` (fixed) and `--admin-hover`'s own value.

## Evidence (acceptance criteria → test or command output)

- ac-1: `theme-css.test.ts` "every T2 token has a light value…" (themed vs shared lists), dark blocks identical.
- ac-2: `tokenization guard (KOBE-498)` block plus pattern self-tests (arbitrary values match; `Run #100`,
  `issue #123,`, `"#add"`, `t("#abc")` do not); red at 0e4f417d, green after.
- ac-3: compiled Tailwind main vs branch (postcss + `@tailwindcss/postcss`, diffed): only radius/font
  variable swaps, the font-stack change above and `bg-status-accent/90` → `bg-brand-primary-hover`
  (same `color-mix`). Playwright not runnable here; CI decides.
- `console-css-guard.test.ts` snapshots refreshed (intended: 2 radii, the new `@theme inline` lines).
- Results: see the final commit's report (web vitest, typecheck, lint minus `@kobe/chart`, licence, hygiene, wording).
