# Theming Kobe: what can be themed

Status: **target state, decisions by Chris 2026-10-28.** Plan and decisions: [`docs/specs/theming.md`](specs/theming.md).
Tickets: KOBE-497 (T1) to KOBE-505 (T9); the T-numbers below refer to them.
Tokens marked _existing_ are in `apps/web/app/theme.css` on `main` today; tokens marked _T2_ arrive
with the tokenization ticket; the Appearance page and the API arrive with T3–T5. The "Set by"
column says what changes a token: **accent** (the admin's accent colour, through `deriveAccent()`),
**preset** (one of the shipped styles), **corners**, **typeface**, **override** (allow-listed token
overrides, optional ticket T8), or **fixed** (never themable, with the reason).

## 1. How theming works

Three layers, one direction:

1. **Inputs** an admin sets on _Site console → System → Appearance_: application name, logo (plus an
   optional dark logo), favicon, and a style (a preset, or accent colour + corners + typeface).
2. **Tokens**: CSS custom properties declared on `:root` in `apps/web/app/theme.css`, with a light
   value and a dark value (dark applies under `<html data-theme="dark">`, or with no saved choice
   when the OS is dark). A style is rendered into one nonced `<style>` in `<head>` that re-declares
   a small set of these tokens; nothing else in the stylesheet changes.
3. **Components** read tokens only: CSS modules through `var(--kobe-…)`, Tailwind utilities through
   the names mapped in `apps/web/app/tailwind.css` (`text-console-fg`, `bg-status-running-bg`,
   `rounded-md`, `font-sans`, …). A guard test (`apps/web/app/theme-css.test.ts`) fails the build
   when a stylesheet or component carries a literal colour, font family or shadow colour.

Members keep their own light/dark choice; a theme always defines both.

## 2. Site identity

| Element       | Where it shows                                                                                                                                                                                            | Rules                                                                                                                                                                                |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| App name      | Bar wordmark (top-left, D9); the brand link of the Site console, Team console and My area; browser titles (`<page> · <name>`); sign-in, setup, invite, forgot/reset-password copy; the Appearance preview | 1–40 characters, plain text, trimmed. Default "Kobe". Never enters CSS.                                                                                                              |
| Logo          | Left of the name in the bar and the console headers (24 px tall, at most 160 px wide, scaled to fit); the Appearance preview                                                                              | PNG, JPEG, WebP or SVG, ≤ 512 KiB, ≤ 4096 px a side. Optional **dark logo** shown when the dark theme is on; otherwise the one logo serves both. SVG content rules: TH8 in the plan. |
| Favicon       | Browser tab, bookmarks, history                                                                                                                                                                           | PNG, SVG or ICO, ≤ 256 KiB. Default: the shipped `apps/web/app/icon.svg`. The browser picks the size from the one file.                                                              |
| Wordmark text | Hidden when a logo carries the name on its own (admin's choice, "Show the name next to the logo"); the name stays the accessible name of the link                                                         | `--kobe-brand-wordmark-size` / `-weight` (T2) decide its type; a preset may set them                                                                                                 |

Asset URLs carry the content hash (`/v1/site/branding/assets/logo?v=<sha256>`), so a change is seen
on the next page load everywhere.

## 3. Style inputs

| Input    | Choices                                                                                          | What it sets                                                                                                                                              |
| -------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Preset   | `default` (today's look), `slate`, `forest`, `plum`, `ember`, `tokyo-nights` (Chris, 2026-10-28) | A complete set of values for every token marked **preset** below, light and dark; each preset meets the contrast floor (§8) by construction (unit-tested) |
| Accent   | One colour (`#rrggbb`), under Custom                                                             | The **brand** tokens: primary fill, its hover, its automatically chosen text colour, the link colour and the focus colour (§4.1)                          |
| Corners  | `sharp`, `soft` (default), `round`                                                               | The **radius** tokens (§6)                                                                                                                                |
| Typeface | `system` (default), `humanist`, `grotesk`, `serif`                                               | `--kobe-font-sans` (§5); monospace stays the system monospace stack                                                                                       |

Custom = accent + corners + typeface on top of the `default` neutrals. A preset may also fix corners
and typeface; the admin can still change those two after picking it.

## 4. Colour tokens

Light and dark defaults are today's values (`apps/web/app/theme.css`); where a preset retints them
the catalogue says so.

### 4.1 Brand (T2; set by accent or preset)

| Token                        | Used for                                                                                        | Light default   | Dark default     | Set by                                                         |
| ---------------------------- | ----------------------------------------------------------------------------------------------- | --------------- | ---------------- | -------------------------------------------------------------- |
| `--kobe-brand-primary`       | The one coloured fill: console primary buttons, accent badges, count pills (`bg-status-accent`) | `#2449c7`       | `#4263eb`        | accent / preset                                                |
| `--kobe-brand-primary-hover` | Hover of the above                                                                              | one step darker | one step lighter | derived from the accent                                        |
| `--kobe-brand-primary-fg`    | Text and icons on the primary fill                                                              | `#ffffff`       | `#ffffff`        | derived: white or near-black, whichever reaches 4.5:1          |
| `--kobe-brand-link`          | Links and accent text (`text-console-accent`, `--admin-accent`)                                 | `#2449c7`       | `#8fa8ff`        | derived: the accent adjusted until 4.5:1 on the page and panel |
| `--kobe-brand-focus`         | Focus rings on controls (`--ring`, `--kobe-composer-focus`)                                     | `#2449c7`       | `#8fa8ff`        | derived: at least 3:1 on page, panel and card                  |

The existing names `--admin-accent`, `--kobe-status-accent` and `--kobe-status-accent-fg` become
aliases of these and stay valid for the stylesheets that read them.

### 4.2 Neutral surfaces and text

Two sets exist today: the chat's (shadcn names, oklch) and the consoles' (`--kobe-console-*`). Both
stay in v1 (the plan's T9 may merge them); a preset retints both together so the app reads as one.

**Chat and shared components** (assistant-ui, Tailwind `bg-background`, `text-muted-foreground`, …):

| Token                                    | Used for                                | Light                                   | Dark                                    | Set by                                   |
| ---------------------------------------- | --------------------------------------- | --------------------------------------- | --------------------------------------- | ---------------------------------------- |
| `--background` / `--foreground`          | Page and body text                      | `oklch(1 0 0)` / `oklch(0.145 0 0)`     | `oklch(0.145 0 0)` / `oklch(0.985 0 0)` | preset                                   |
| `--card` / `--card-foreground`           | Cards (message cards, tool steps)       | white / near-black                      | `oklch(0.205 0 0)` / near-white         | preset                                   |
| `--popover` / `--popover-foreground`     | Menus, tooltips, dialogs                | as card                                 | as card                                 | preset                                   |
| `--primary` / `--primary-foreground`     | assistant-ui's primary button (send)    | `oklch(0.205 0 0)` / `oklch(0.985 0 0)` | inverted                                | preset (stays neutral under Custom, TH3) |
| `--secondary` / `--secondary-foreground` | Secondary buttons                       | `oklch(0.97 0 0)`                       | `oklch(0.269 0 0)`                      | preset                                   |
| `--muted` / `--muted-foreground`         | Rail and panel surfaces, secondary text | `oklch(0.97 0 0)` / `oklch(0.556 0 0)`  | `oklch(0.269 0 0)` / `oklch(0.708 0 0)` | preset                                   |
| `--accent` / `--accent-foreground`       | Hover surfaces of menu items            | `oklch(0.97 0 0)`                       | `oklch(0.269 0 0)`                      | preset                                   |
| `--border` / `--input`                   | Dividers / control borders              | `oklch(0.922 0 0)`                      | `oklch(1 0 0 / 10%)` / `15%`            | preset                                   |
| `--ring`                                 | Focus ring                              | → `--kobe-brand-focus` (T2)             | same                                    | accent                                   |
| `--destructive`                          | Destructive buttons                     | `oklch(0.577 0.245 27.325)`             | `oklch(0.704 0.191 22.216)`             | **fixed** (meaning)                      |

**Consoles and My area** (Tailwind `bg-console-*`, `text-console-*`, `border-console-*`):

| Token                           | Used for                                                               | Light              | Dark               | Set by |
| ------------------------------- | ---------------------------------------------------------------------- | ------------------ | ------------------ | ------ |
| `--kobe-console-bg`             | Page                                                                   | `#ffffff`          | `#16161a`          | preset |
| `--kobe-console-panel`          | Panels, side navigation, table heads                                   | `#f4f4f6`          | `#202027`          | preset |
| `--kobe-console-fg`             | Body text                                                              | `#1b1b1f`          | `#ececf1`          | preset |
| `--kobe-console-muted`          | Secondary text, descriptions                                           | `#5b5b66`          | `#a5a5b2`          | preset |
| `--kobe-console-border`         | Decorative dividers only                                               | `#d9d9df`          | `#3a3a45`          | preset |
| `--kobe-console-control-border` | Form-control boundaries (must keep 3:1 on page and panel, WCAG 1.4.11) | `#80808c`          | `#74747f`          | preset |
| `--kobe-console-overlay`        | Backdrop behind a console dialog                                       | `rgb(0 0 0 / 50%)` | `rgb(0 0 0 / 70%)` | preset |

**Legacy aliases** (moved to `:root` in T2; read by the rail, shell and shared notices):
`--admin-fg` → `--foreground`, `--admin-muted` → `--muted-foreground`, `--admin-bg` → `--background`,
`--admin-panel` → `--muted`, `--admin-border` → `--border`, `--admin-hover` (T2) → `--accent`.
They follow whatever the preset sets; do not theme them directly.

### 4.3 Shared accents and warnings

| Token               | Used for                                | Light     | Dark      | Set by              |
| ------------------- | --------------------------------------- | --------- | --------- | ------------------- |
| `--admin-accent`    | Alias of `--kobe-brand-link`            | `#2449c7` | `#8fa8ff` | accent              |
| `--admin-danger`    | Error text, destructive console actions | `#a4161a` | `#ff8a8a` | **fixed** (meaning) |
| `--admin-danger-bg` | Error notice background                 | `#fdecec` | `#3a1c1e` | **fixed**           |
| `--admin-warn-bg`   | Warning notice background               | `#fff4d6` | `#3a3218` | **fixed**           |

### 4.4 Status and semantic colours (fixed)

These carry meaning and keep tuned WCAG AA contrast on the page, the rail panel, cards and their
own tints in both themes (checked by `theme-css.test.ts` and `e2e/browser/tests/theme.spec.ts`).
Presets and the Appearance page never change them; a preset that retints surfaces must keep
their contrast, which the preset unit test asserts.

| Group           | Tokens                                                                                                                                                                  | Why fixed                                           |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Activity status | `--kobe-status-running(-bg)`, `-attention(-bg)`, `-failed(-bg)`, `-done`, `-idle`                                                                                       | Green/amber/red/grey read the same on every install |
| Confirm action  | `--kobe-confirm`, `--kobe-confirm-hover`, `--kobe-confirm-fg`                                                                                                           | "Commits nothing" green, Chris 2026-10-23           |
| Tool badge      | `--kobe-tool-badge`, `--kobe-tool-badge-bg`, `--kobe-tool-badge-border`                                                                                                 | Gold identity of tool calls                         |
| Diff            | `--kobe-diff-added(-bg)`, `--kobe-diff-deleted(-bg)` (derived from status)                                                                                              | Follow status colours                               |
| Context gauge   | `--kobe-gauge-ok`, `--kobe-gauge-warn`, `--kobe-gauge-full` (derived from status)                                                                                       | Follow status colours                               |
| Context viewer  | `--kobe-ctx-system-prompt`, `-agent-instructions`, `-skills`, `-memory`, `-viewing-file`, `-tool-definitions`, `-user`, `-assistant`, `-tools`, `-compaction`, `-other` | Okabe-Ito/Tol hues chosen for colour-vision safety  |
| Theme switch    | `--kobe-when-light`, `--kobe-when-dark` (`display` values)                                                                                                              | Mechanism, not style                                |

## 5. Typography (T2)

| Token                          | Used for                                      | Default                                                    | Set by            |
| ------------------------------ | --------------------------------------------- | ---------------------------------------------------------- | ----------------- |
| `--kobe-font-sans`             | Everything (`font-sans`, chat root, consoles) | `system-ui, sans-serif`                                    | typeface / preset |
| `--kobe-font-mono`             | Code, file editor, context viewer             | `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace` | preset            |
| `--kobe-brand-wordmark-size`   | The bar's app name                            | `1.125rem`                                                 | preset            |
| `--kobe-brand-wordmark-weight` | The bar's app name                            | `600`                                                      | preset            |

Typeface stacks (`apps/web/lib/theme/presets.ts`): `system` = today's; `humanist` =
`Seravek, "Gill Sans Nova", Ubuntu, Calibri, "DejaVu Sans", source-sans-pro, sans-serif`;
`grotesk` = `Inter, Roboto, "Helvetica Neue", "Arial Nova", "Nimbus Sans", Arial, sans-serif`;
`serif` = `Charter, "Bitstream Charter", "Sitka Text", Cambria, serif`. All system stacks: no font
files are loaded (`font-src 'self'` stays and nothing is shipped). Sizes, weights and line heights
other than the wordmark's are not themable.

## 6. Corners (T2)

| Token                | Used for                                     | sharp | soft (default) | round     |
| -------------------- | -------------------------------------------- | ----- | -------------- | --------- |
| `--kobe-radius-sm`   | Chips, badges, small controls (`rounded-sm`) | `0`   | `0.25rem`      | `0.5rem`  |
| `--kobe-radius-md`   | Buttons, inputs, menu items (`rounded-md`)   | `0`   | `0.375rem`     | `0.75rem` |
| `--kobe-radius-lg`   | Cards, panels, dialogs (`rounded-lg`)        | `0`   | `0.5rem`       | `1rem`    |
| `--kobe-radius-xl`   | Composer, artifact panel (`rounded-xl`)      | `0`   | `0.75rem`      | `1.25rem` |
| `--kobe-radius-pill` | Count pills, toggles                         | `0`   | `9999px`       | `9999px`  |

Tailwind's `--radius-*` scale maps onto these in `apps/web/app/tailwind.css`, so existing
`rounded-*` utilities follow without edits.

## 7. Shadows and scrims (T2; preset only)

| Token                  | Used for                                       | Light                            | Dark                             |
| ---------------------- | ---------------------------------------------- | -------------------------------- | -------------------------------- |
| `--kobe-shadow-pop`    | Menus, pickers, tooltips, the new-build banner | `0 4px 16px rgb(0 0 0 / 15%)`    | `0 4px 16px rgb(0 0 0 / 45%)`    |
| `--kobe-shadow-drawer` | The rail drawer and the artifact column edge   | `0 8px 24px rgb(0 0 0 / 12%)`    | `0 8px 24px rgb(0 0 0 / 40%)`    |
| `--kobe-shadow-panel`  | Workspace panels over the chat                 | `0 1.5rem 4rem rgb(0 0 0 / 25%)` | `0 1.5rem 4rem rgb(0 0 0 / 55%)` |
| `--kobe-scrim`         | The drawer's full-window scrim                 | `rgb(0 0 0 / 40%)`               | `rgb(0 0 0 / 60%)`               |

Dark defaults are set in T2 to match today's rendering (the current literal values are the light
ones in both themes).

## 8. Rules every theme must meet

Enforced by the preset unit test, by `deriveAccent()` for a custom accent, by the server on `PUT`,
and on kobe-gate1 by `theme.spec.ts`:

1. Body text on page, panel and card: ≥ 4.5:1 in both themes (`--foreground`/`--kobe-console-fg`;
   muted text too).
2. Links (`--kobe-brand-link`) on page and panel: ≥ 4.5:1 in both themes.
3. Primary fill text (`--kobe-brand-primary-fg` on `--kobe-brand-primary` and its hover): ≥ 4.5:1.
4. Focus colour against page, panel and card: ≥ 3:1 (WCAG 1.4.11); control borders likewise.
5. Status colours keep their documented ratios on the retinted surfaces (§4.4).
6. Colour never carries meaning alone: every status has a label or icon; a theme cannot remove them.
7. The two dark blocks in `theme.css` and in the rendered theme `<style>` are identical.

## 9. What cannot be themed, and why

- **Status, danger, confirm, tool, diff and context-viewer colours** (§4.4): meaning and
  colour-vision safety.
- **Layout**: rail widths (`--kobe-rail-width`, `--kobe-rail-room`, `--kobe-artifact-width`),
  breakpoints, viewport variables, densities. They are behaviour, not style.
- **Artifact frames and MCP app frames**: sandboxed documents with their own CSP; the host's tokens
  do not reach them (an app may read `prefers-color-scheme` itself).
- **Isolation banner and the setup wizard's safety copy**: fixed wording and colours.
- **Per-team or per-user brand**: one organisation, one brand (TH1); members keep light/dark only.
- **Custom CSS or font files** (v1): see TH2 and TH10 in the plan.

## 10. Adding or changing a token

1. Declare it in `apps/web/app/theme.css` with a light value on `:root` and the same dark value in
   both dark blocks (the test checks equality and that every dark token has a light value).
2. Map it in `apps/web/app/tailwind.css` (`@theme inline`) when a utility should read it.
3. Decide its column here: brand / preset / corners / typeface / override / fixed, and add it to
   `presets.ts` when a preset sets it, or to the override allow-list (T8) when an admin may.
4. If it carries a contrast rule, add the pair to `theme-css.test.ts` and, where it reaches the
   screen, to `e2e/browser/tests/support/colours.ts`.
5. Read it through `var(--kobe-…)` or the Tailwind name; never copy its value into another file
   (the guard test fails on literal colours, font families and shadow colours outside `theme.css`).

## 11. Tailwind names

| Tailwind utility family                                                                                                                                                                                                                           | Tokens                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `bg-background`, `text-foreground`, `bg-card`, `bg-popover`, `bg-muted`, `text-muted-foreground`, `bg-primary`, `bg-secondary`, `bg-accent`, `border-border`, `border-input`, `ring-ring`, `text-destructive`                                     | shadcn neutrals (§4.2)                    |
| `bg-console-bg`, `bg-console-panel`, `text-console-fg`, `text-console-muted`, `border-console-border`, `border-console-control`, `bg-console-overlay`, `text-console-accent`, `text-console-danger`, `bg-console-danger-bg`, `bg-console-warn-bg` | console neutrals and accents (§4.2, §4.3) |
| `text-status-*`, `bg-status-*-bg`, `bg-status-accent`, `text-status-accent-fg`                                                                                                                                                                    | status (§4.4) and brand primary (§4.1)    |
| `bg-confirm`, `hover:bg-confirm-hover`, `text-confirm-fg`                                                                                                                                                                                         | confirm (§4.4)                            |
| `text-tool-badge`, `bg-tool-badge-bg`, `border-tool-badge-border`                                                                                                                                                                                 | tool badge (§4.4)                         |
| `bg-brand-primary`, `text-brand-link`, `ring-brand-focus` (T2)                                                                                                                                                                                    | brand (§4.1)                              |
| `font-sans`, `font-mono` (T2)                                                                                                                                                                                                                     | typography (§5)                           |
| `rounded-sm                                                                                                                                                                                                                                       | md                                        | lg  | xl  | full` (T2 mapping) | corners (§6) |
| `shadow-pop`, `shadow-drawer`, `shadow-panel` (T2)                                                                                                                                                                                                | shadows (§7)                              |
