# KOBE-498: Theming T2: tokenize the web UI

- **Status:** done on the group branch (no push/PR, group rule 2026-10-15)
- **Branch / worktree:** `kobe-498-tokenize-ui` in `../Kobe-wt498`
- **Depends on:** nothing. Plan: `docs/specs/theming.md` §5 (TH3), catalogue `docs/theming.md` (branch `theming-plan`)

## Plan

Tests first (`apps/web/app/theme-css.test.ts`), then `theme.css` tokens, `tailwind.css` mappings,
CSS modules and two TSX lines. Zero visual change: every token holds the literal it replaces.

## Tokens added (`apps/web/app/theme.css`, `:root`; themed ones in both identical dark blocks)

| Token                                    | Light                                                             | Dark      | Replaces / read by                                             |
| ---------------------------------------- | ----------------------------------------------------------------- | --------- | -------------------------------------------------------------- |
| `--kobe-brand-primary`                   | `#2449c7`                                                         | `#4263eb` | `--kobe-status-accent` now reads it                            |
| `--kobe-brand-primary-hover`             | `color-mix(in oklab, var(--kobe-brand-primary) 90%, transparent)` | (follows) | = today's `bg-status-accent/90`                                |
| `--kobe-brand-primary-fg`                | `#ffffff`                                                         | `#ffffff` | `--kobe-status-accent-fg` reads it                             |
| `--kobe-brand-link`                      | `#2449c7`                                                         | `#8fa8ff` | `--admin-accent` reads it                                      |
| `--kobe-brand-focus`                     | `#2449c7`                                                         | `#8fa8ff` | chat `.app :focus-visible` (was `--admin-accent`, same values) |
| `--admin-fg/-muted/-bg/-panel/-border`   | moved from `chat.module.css .app`, same mappings                  |           | rail, shell                                                    |
| `--admin-hover`                          | `rgb(127 127 127 / 12%)`                                          | (same)    | rail `.appRow:hover` fallback value                            |
| `--kobe-font-sans`                       | Tailwind 4.3 default sans stack                                   |           | `font-sans` (console layout, tool-call)                        |
| `--kobe-font-mono`                       | Tailwind 4.3 default mono stack                                   |           | `font-mono`, code editor (`var(--font-mono, …)`)               |
| `--kobe-font-chat`                       | `system-ui, sans-serif`                                           |           | chat `.app` root                                               |
| `--kobe-font-chat-mono`                  | `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`        |           | chat code (2), context viewer                                  |
| `--kobe-brand-wordmark-size` / `-weight` | `1.125rem` / `600`                                                |           | `shell.module.css .wordmark`                                   |
| `--kobe-radius-sm/md/lg/xl/pill`         | `0.25rem/0.375rem/0.5rem/0.75rem/9999px`                          |           | modules + `rounded-*`                                          |
| `--kobe-shadow-pop`                      | `0 4px 16px rgb(0 0 0 / 15%)`                                     | same      | chat 405, rail 479                                             |
| `--kobe-shadow-banner`                   | `0 4px 16px rgb(0 0 0 / 18%)`                                     | same      | new-build banner                                               |
| `--kobe-shadow-drawer`                   | `0 8px 24px rgb(0 0 0 / 12%)`                                     | same      | rail 221, shell 103                                            |
| `--kobe-shadow-edge`                     | `-8px 0 24px rgb(0 0 0 / 16%)`                                    | same      | shell 365 (artifact column)                                    |
| `--kobe-shadow-panel`                    | `0 1.5rem 4rem rgb(0 0 0 / 25%)`                                  | same      | workspace panel                                                |
| `--kobe-scrim`                           | `rgb(0 0 0 / 40%)`                                                | same      | rail drawer `0 0 0 100vmax …`                                  |
| `--kobe-ctx-pattern-stripe` / `-dot`     | `rgb(255 255 255 / 45%)` / `55%`                                  |           | context-viewer patterns                                        |

Kept own values (catalogue default differs, existing wins): `--ring` (grey), `--kobe-composer-focus`.

## Literals replaced

- `border-radius`: 22× `0.375rem`, 11× `0.5rem`, 3× `0.25rem`, 1× `0.75rem`, 7× `999px`,
  1× `0.1875rem` (→ `calc(var(--kobe-radius-sm) * 0.75)`), 2× in `chat-global.css`. Kept: `50%`, `0`, `inherit`.
- `font-family`: `chat.module.css` ×3, `context-viewer.module.css`, `code-editor.tsx`.
- `box-shadow`/scrim: the 8 `rgb(0 0 0 / …)` in chat, rail (3), shell (2), workspace-panel, banner.
- Fallbacks dropped: rail (4), icon-action (3), context-gauge (1).
- `markers.tsx`: `text-amber-700 dark:text-amber-400` → `text-status-attention`.
- `tailwind.css @theme inline`: `--color-brand-*` (5), `--font-sans/-mono/-chat/-chat-mono`,
  `--radius-sm..xl`, `--radius-full` → pill, `--shadow-pop/-banner/-drawer/-edge/-panel`.

## Decisions

- **Equality by construction.** Each token holds the literal it replaced (`0.12` = `12%`, `0.4` = `40%`).
  Compiled Tailwind output, main vs branch (postcss + `@tailwindcss/postcss`, prettier, diff): only
  `var(--radius-x)` → `var(--kobe-radius-x)` and `var(--font-x)` → `var(--kobe-font-x)` with the same
  values, `rounded-full` `calc(infinity * 1px)` → `9999px`, and an unused `.shadow` class (candidate
  picked up from the test file's text).
- `rounded-full`/`999px` → `9999px`: pixel-identical for any box under 1998px on its short side
  (corner radii clamp to half the side, CSS Backgrounds 3 §5.5).
- `--admin-*` aliases on `:root`: every reader renders inside `.app` (portals use
  `chatPortalContainer()`), so values are unchanged there.
- **Two sans and two mono tokens**: today the shell (`system-ui`) and the console content (Tailwind's
  stack) render side by side in the console screenshots, so one token cannot keep both.
- Shadows: banner (18%) and artifact edge (`-8px 0`, 16%) differ from pop/drawer, so they got their
  own tokens rather than a pixel change.

## Open questions (for Chris or the coordinator)

- Chat code mono: `ui-monospace, monospace` → the context viewer's stack (`+ SFMono-Regular, Menlo,
Consolas`). Same font on Linux CI, Safari, and Windows (Consolas is Chrome's default there); could differ
  on macOS Chrome. Not in any baseline.
- Markers' warn text: amber-700/400 → status attention (`#a14b05`/`#fbbf24`), a small chat colour change,
  as the ticket asked (not in the console baselines).
- Catalogue vs this ticket: `--kobe-font-chat(-mono)`, `--kobe-shadow-banner/-edge`, `--kobe-ctx-pattern-*`
  and `--admin-hover`'s own value (catalogue says → `--accent`) need adding to `docs/theming.md`;
  T4 presets should set all four font tokens. Dark shadows equal light for now (brief).
- Guard leaves `bg-black`/`bg-white`/`text-white` (overlays, frames) alone: not hue-scale palette classes.

## Evidence (acceptance criteria → test or command output)

- ac-1: `theme-css.test.ts` "every T2 token has a light value…", "the chosen-dark and OS-dark blocks…".
- ac-2: `tokenization guard (KOBE-498)` block (colour, shadow, font, radius, TSX palette; self-test
  of the patterns); red at 0e4f417d, green after.
- ac-3: by construction (above); `theme.spec.ts`/`consoles.spec.ts` not runnable here (no Playwright), CI proves.
- `console-css-guard.test.ts` snapshots refreshed (intended): `chat-global.own.css.snap` (2 radii →
  `var(--kobe-radius-md)`), `chat-theme.css.snap` (the new `@theme inline` mappings).
- `@kobe/web` vitest 2638/2638; `pnpm typecheck` green; lint green for every package but `@kobe/chart`
  (`helm` not installed here); `license:check`, public hygiene, site wording ok; `pnpm format` applied.
