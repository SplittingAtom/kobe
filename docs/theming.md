# Theming Kobe: what can be themed

Status: **Shipped 2026-10-29 (KOBE-497..503).** Plan and decisions: [`docs/specs/theming.md`](specs/theming.md).
Every token below is declared in `apps/web/app/theme.css`; the presets are in
`apps/web/lib/theme/presets.ts`, the accent maths and the contrast floor in
`packages/protocol/src/theme/accent.ts`, the API in `services/server/src/routes/site-branding.ts`.
The "Set by" column says what changes a token: **accent** (the admin's accent colour under Custom,
through `deriveAccent()`), **preset** (one of the six shipped styles), **corners**, **typeface**, or
**fixed** (never themable, with the reason). There are no per-token overrides in this release (the
optional KOBE-504 would add an allow-list).

## 1. How theming works

Three layers, one direction:

1. **Inputs** an admin sets on _Site console → System → Appearance_ (§12): site name, whether the
   name shows next to the logo, logo (plus an optional dark logo), favicon, and a style (a preset,
   or Custom: accent colour + corners + typeface).
2. **Tokens**: CSS custom properties declared on `:root` in `apps/web/app/theme.css`, with a light
   value and a dark value (dark applies under `<html data-theme="dark">`, or with no saved choice
   when the OS is dark). A style is rendered by `brandingCss()` (`apps/web/lib/theme/branding-css.ts`)
   into one nonced `<style>` in `<head>` that re-declares a small set of these tokens; nothing else
   in the stylesheet changes. The `default` preset renders nothing: the page is theme.css alone.
3. **Components** read tokens only: CSS modules through `var(--kobe-…)`, Tailwind utilities through
   the names mapped in `apps/web/app/tailwind.css` (`text-console-fg`, `bg-status-running-bg`,
   `rounded-md`, `font-sans`, …). A guard test (`apps/web/app/theme-css.test.ts`) fails the build
   when a stylesheet or component carries a literal colour, font family or shadow colour.

Members keep their own light/dark choice; a theme always defines both.

The web reads the branding from the server on every server render (`GET /v1/site/branding` through
`KOBE_SERVER_URL`, see [install.md](install.md#branding-and-theming)), with a 1 s timeout and a
30 s stale-while-revalidate cache per web replica; when the server cannot be reached it serves
Kobe's defaults and logs at most once a minute. So the first paint is already themed.

## 2. Site identity

| Element       | Where it shows                                                                                                                                                                                      | Rules                                                                                                                                                                                                           |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Site name     | Bar wordmark (top-left, D9); the brand link of the Site console, Team console and My area; browser titles (`<page> · <name>`); sign-in, setup, invite, forgot-password copy; the Appearance preview | 1–40 characters (code points), trimmed, plain text on one line (no control, format or line/paragraph separator characters). Default "Kobe". Never enters CSS. Setting `branding.app_name`.                      |
| Logo          | Left of the name in the bar and the console headers (24 px tall, at most 160 px wide, scaled to fit); the Appearance preview                                                                        | PNG, JPEG, WebP or SVG, ≤ 512 KiB, raster ≤ 4096 px a side. Optional **dark logo** (same rules) shown when the dark theme is on; otherwise the one logo serves both. A dark logo needs a logo. SVG rules: §2.1. |
| Favicon       | Browser tab, bookmarks, history                                                                                                                                                                     | PNG, SVG or ICO, ≤ 256 KiB. Default: the shipped `apps/web/app/icon.svg`. The browser picks the size from the one file.                                                                                         |
| Wordmark text | Hidden when a logo carries the name on its own ("Show the name next to the logo" off, setting `branding.show_name`); the name stays the accessible name of the link; without a logo it always shows | `--kobe-brand-wordmark-size` / `-weight` decide its type (fixed in this release: no preset sets them)                                                                                                           |

The file type is detected from the bytes (magic numbers; SVG parsed as XML), never from the
upload's declared type; raster sizes are read from the file and capped. Files are stored in Postgres
(`site_branding_assets`) and served by the server at `/v1/site/branding/assets/<kind>?v=<sha256>`
(`logo`, `logo_dark`, `favicon`): with the current hash the response is
`Cache-Control: public, max-age=31536000, immutable`, otherwise `no-cache` with an `ETag`; always
`X-Content-Type-Options: nosniff` and
`Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox`. A change is seen on
the next page load everywhere (other web replicas within 30 s).

### 2.1 SVG rules

An SVG is **refused, with the reason**, never sanitised (`services/server/src/branding/svg.ts`).
The server reads it with a small strict XML reader; anything it cannot read is refused as not
well-formed. Accepted: UTF-8, one `<svg>` root in the SVG namespace (`xmlns="http://www.w3.org/2000/svg"`).
Refused:

- **Namespaces:** any declaration other than the SVG namespace and `xmlns:xlink`
  (`http://www.w3.org/1999/xlink`); any prefixed element (`<sodipodi:namedview>`, `<inkscape:…>`);
  any prefixed attribute other than `xlink:` and `xml:`.
- **Declarations:** a DOCTYPE or entity declaration, an entity reference other than the five
  predefined ones and character references; processing instructions other than the XML
  declaration (e.g. `xml-stylesheet`).
- **Elements:** `script`, `foreignObject`, `meta`, `iframe`, `form`, `embed`, `object`, `base`,
  `link`, `handler`; nesting deeper than 256.
- **Attributes:** any `on*` event handler; `content`, `action`, `src`, `formaction`; an `href` or
  `xlink:href` that is not a `#fragment`; an animation (`animate`, `set`, `animateMotion`,
  `animateTransform`, `discard`) whose `attributeName` targets a link.
- **CSS and attribute values** (a `style` attribute, a `<style>` element, any attribute): `url(`
  other than `url(#id)`; `@import`; `image-set(` or `src(`; any backslash (CSS escapes).

`url(#id)` references inside the image (gradients, clip paths, masks, markers) are allowed. The
image's box comes from the root's `width`/`height`, else its `viewBox`.

**Inkscape:** save as **Plain SVG** (Inkscape's own format carries `sodipodi:`/`inkscape:`
namespaces and is refused). The Appearance page adds this hint to every SVG refusal.

## 3. Style inputs

| Input    | Choices                                                              | What it sets                                                                                                                                                                                 |
| -------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Preset   | `default`, `slate`, `forest`, `plum`, `ember`, `tokyo-nights` (§3.1) | A complete set of values for every token marked **preset** below, light and dark, plus its corners and typeface; each preset meets the contrast floor (§8), unit-tested                      |
| Accent   | One colour (`#rrggbb`, lowercase hex), under Custom                  | The **brand** tokens per scheme (§4.1): primary fill, its hover, its text colour, the link colour and the focus colour; also points `--ring` and `--kobe-composer-focus` at the focus colour |
| Corners  | `sharp`, `soft` (default), `round`, under Custom                     | The **radius** tokens (§6)                                                                                                                                                                   |
| Typeface | `system` (default), `humanist`, `grotesk`, `serif`, under Custom     | `--kobe-font-sans` (§5); monospace stays the system monospace stack                                                                                                                          |

Stored as `branding.theme`: `{"preset":"<id>"}` or
`{"preset":"custom","accent":"#rrggbb","corners":"…","font":"…"}`. A preset fixes its own corners and
typeface. Custom = accent + corners + typeface on top of the `default` neutrals; choosing Custom
on the Appearance page starts from the selected preset's corners and typeface.

### 3.1 The presets

| Id             | Display name | Corners | Typeface | Look                                                                                                                          |
| -------------- | ------------ | ------- | -------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `default`      | Default      | soft    | system   | Today's neutral look, theme.css byte for byte (the built-in default; renders no `<style>`)                                    |
| `slate`        | Slate        | soft    | grotesk  | Cool blue-grey neutrals, slate-blue accent (light `#3d5a80`, dark `#4a6a9e`, dark link `#9db6dc`)                             |
| `forest`       | Forest       | round   | humanist | Green-tinted neutrals, deep forest accent (light `#2d6a4f`, dark `#2f7353`, dark link `#8fd1ab`)                              |
| `plum`         | Plum         | soft    | serif    | Violet-tinted neutrals, plum accent (light `#7a3e8a`, dark `#8a4a9c`, dark link `#d7a8e3`)                                    |
| `ember`        | Ember        | sharp   | grotesk  | Warm neutrals, burnt-orange accent (light `#b03d12`, link `#a63a10`; dark `#e07a3f` with near-black text, link `#f5a571`)     |
| `tokyo-nights` | Tokyo Nights | round   | system   | After the Tokyo Night editor palette: indigo night (dark page `#1a1b26`), periwinkle accent `#7aa2f7`, violet focus `#bb9af7` |

Every preset value is in `apps/web/lib/theme/presets.ts` (`PRESETS`); the token list a preset sets
per scheme is `PRESET_SCHEME_TOKENS` (the brand tokens, both neutral sets, `--ring` and
`--kobe-composer-focus`). Presets do not set shadows, the mono stack or the wordmark.

## 4. Colour tokens

Light and dark defaults are the `default` preset's (`apps/web/app/theme.css`); where a preset
retints them the catalogue says so.

### 4.1 Brand (set by accent or preset)

| Token                        | Used for                                                                                        | Light default                                                     | Dark default | Set by          |
| ---------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------ | --------------- |
| `--kobe-brand-primary`       | The one coloured fill: console primary buttons, accent badges, count pills (`bg-status-accent`) | `#2449c7`                                                         | `#4263eb`    | accent / preset |
| `--kobe-brand-primary-hover` | Hover of the above                                                                              | `color-mix(in oklab, var(--kobe-brand-primary) 90%, transparent)` | same         | accent / preset |
| `--kobe-brand-primary-fg`    | Text and icons on the primary fill                                                              | `#ffffff`                                                         | `#ffffff`    | accent / preset |
| `--kobe-brand-link`          | Links and accent text (`text-console-accent`, `--admin-accent`)                                 | `#2449c7`                                                         | `#8fa8ff`    | accent / preset |
| `--kobe-brand-focus`         | Focus outlines on controls                                                                      | `#2449c7`                                                         | `#8fa8ff`    | accent / preset |

`--admin-accent` (→ `--kobe-brand-link`), `--kobe-status-accent` (→ `--kobe-brand-primary`) and
`--kobe-status-accent-fg` (→ `--kobe-brand-primary-fg`) are aliases and stay valid for the
stylesheets that read them.

**Derived accent** (`deriveAccent()`, per scheme, measured against the `default` preset's console
surfaces: light page `#ffffff`, panel `#f4f4f6`, card `#ffffff`; dark page `#16161a`, panel and
card `#202027`). Lightness moves in OKLCH steps of 0.01, at most 100 steps:

| Token      | Light                                                             | Dark                                                          |
| ---------- | ----------------------------------------------------------------- | ------------------------------------------------------------- |
| primary    | the accent as given                                               | the accent lightened until ≥ 3:1 on the dark page and panel   |
| hover      | the light primary 0.06 OKLCH lightness darker                     | the dark primary 0.06 darker                                  |
| primary fg | `#ffffff` or `#111111`, whichever contrasts more with the primary | the same choice against the dark primary                      |
| link       | the accent darkened until ≥ 4.5:1 on the light page and panel     | the accent lightened until ≥ 4.5:1 on the dark page and panel |
| focus      | the light link darkened until ≥ 3:1 on page, panel and card       | the dark link lightened until ≥ 3:1 on page, panel and card   |

Under Custom the theme `<style>` also sets `--ring` and `--kobe-composer-focus` to
`var(--kobe-brand-focus)` (TH3); the chat's `--primary` (send button) stays neutral.

### 4.2 Neutral surfaces and text

Two sets exist: the chat's (shadcn names, oklch) and the consoles' (`--kobe-console-*`). Both stay
in v1 (the plan's optional T9, KOBE-505, may merge them); a preset retints both together so the app
reads as one. Custom keeps the `default` neutrals.

**Chat and shared components** (assistant-ui, Tailwind `bg-background`, `text-muted-foreground`, …):

| Token                                    | Used for                                | Light                                   | Dark                                        | Set by                                           |
| ---------------------------------------- | --------------------------------------- | --------------------------------------- | ------------------------------------------- | ------------------------------------------------ |
| `--background` / `--foreground`          | Page and body text                      | `oklch(1 0 0)` / `oklch(0.145 0 0)`     | `oklch(0.145 0 0)` / `oklch(0.985 0 0)`     | preset                                           |
| `--card` / `--card-foreground`           | Cards (message cards, tool steps)       | `oklch(1 0 0)` / `oklch(0.145 0 0)`     | `oklch(0.205 0 0)` / `oklch(0.985 0 0)`     | preset                                           |
| `--popover` / `--popover-foreground`     | Menus, tooltips, dialogs                | as card                                 | as card                                     | preset                                           |
| `--primary` / `--primary-foreground`     | assistant-ui's primary button (send)    | `oklch(0.205 0 0)` / `oklch(0.985 0 0)` | `oklch(0.922 0 0)` / `oklch(0.205 0 0)`     | preset (stays neutral under Custom, TH3)         |
| `--secondary` / `--secondary-foreground` | Secondary buttons                       | `oklch(0.97 0 0)` / `oklch(0.205 0 0)`  | `oklch(0.269 0 0)` / `oklch(0.985 0 0)`     | preset                                           |
| `--muted` / `--muted-foreground`         | Rail and panel surfaces, secondary text | `oklch(0.97 0 0)` / `oklch(0.556 0 0)`  | `oklch(0.269 0 0)` / `oklch(0.708 0 0)`     | preset                                           |
| `--accent` / `--accent-foreground`       | Hover surfaces of menu items            | `oklch(0.97 0 0)` / `oklch(0.205 0 0)`  | `oklch(0.269 0 0)` / `oklch(0.985 0 0)`     | preset                                           |
| `--border` / `--input`                   | Dividers / control borders              | `oklch(0.922 0 0)` (both)               | `oklch(1 0 0 / 10%)` / `oklch(1 0 0 / 15%)` | preset                                           |
| `--ring`                                 | The chat's focus ring                   | `oklch(0.708 0 0)`                      | `oklch(0.556 0 0)`                          | preset; accent points it at `--kobe-brand-focus` |
| `--destructive`                          | Destructive buttons                     | `oklch(0.577 0.245 27.325)`             | `oklch(0.704 0.191 22.216)`                 | **fixed** (meaning)                              |

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

**Legacy aliases** (on `:root`; read by the rail, shell and shared notices):
`--admin-fg` → `--foreground`, `--admin-muted` → `--muted-foreground`, `--admin-bg` → `--background`,
`--admin-panel` → `--muted`, `--admin-border` → `--border`. They follow whatever the preset sets; do
not theme them directly. `--admin-hover` (the rail's row hover) is not an alias: a translucent grey
`rgb(127 127 127 / 12%)`, the same in both themes, **fixed**.

### 4.3 Shared accents, outlines and warnings

| Token                   | Used for                                         | Light     | Dark      | Set by                                           |
| ----------------------- | ------------------------------------------------ | --------- | --------- | ------------------------------------------------ |
| `--admin-accent`        | Alias of `--kobe-brand-link`                     | `#2449c7` | `#8fa8ff` | accent / preset (through the link)               |
| `--kobe-composer-focus` | The composer panel's focus outline (3:1 or more) | `#52525b` | `#a1a1aa` | preset; accent points it at `--kobe-brand-focus` |
| `--admin-danger`        | Error text, destructive console actions          | `#a4161a` | `#ff8a8a` | **fixed** (meaning)                              |
| `--admin-danger-bg`     | Error notice background                          | `#fdecec` | `#3a1c1e` | **fixed**                                        |
| `--admin-warn-bg`       | Warning notice background                        | `#fff4d6` | `#3a3218` | **fixed**                                        |

### 4.4 Status and semantic colours (fixed)

These carry meaning and keep tuned WCAG AA contrast on the page, the rail panel, cards and their
own tints in both themes (checked by `theme-css.test.ts` and `e2e/browser/tests/theme.spec.ts`).
Presets and the Appearance page never change them; the preset unit test asserts they keep 4.5:1
on every preset's surfaces.

| Group            | Tokens                                                                                                                                                                  | Why fixed                                                 |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Activity status  | `--kobe-status-running(-bg)`, `-attention(-bg)`, `-failed(-bg)`, `-done`, `-idle`                                                                                       | Green/amber/red/grey read the same on every site          |
| Confirm action   | `--kobe-confirm`, `--kobe-confirm-hover`, `--kobe-confirm-fg`                                                                                                           | "Commits nothing" green, Chris 2026-10-23                 |
| Tool badge       | `--kobe-tool-badge`, `--kobe-tool-badge-bg`, `--kobe-tool-badge-border`                                                                                                 | Gold identity of tool calls                               |
| Diff             | `--kobe-diff-added(-bg)`, `--kobe-diff-deleted(-bg)` (derived from status)                                                                                              | Follow status colours                                     |
| Context gauge    | `--kobe-gauge-ok`, `--kobe-gauge-warn`, `--kobe-gauge-full` (derived from status)                                                                                       | Follow status colours                                     |
| Context viewer   | `--kobe-ctx-system-prompt`, `-agent-instructions`, `-skills`, `-memory`, `-viewing-file`, `-tool-definitions`, `-user`, `-assistant`, `-tools`, `-compaction`, `-other` | Okabe-Ito/Tol hues chosen for colour-vision safety        |
| Context patterns | `--kobe-ctx-pattern-stripe` (`rgb(255 255 255 / 45%)`), `--kobe-ctx-pattern-dot` (`rgb(255 255 255 / 55%)`), the same in both themes                                    | The stripes and dots that tell kinds apart without colour |
| Theme switch     | `--kobe-when-light`, `--kobe-when-dark` (`display` values; also swap the dark logo)                                                                                     | Mechanism, not style                                      |

## 5. Typography

| Token                          | Used for                                      | Default                                                    | Set by            |
| ------------------------------ | --------------------------------------------- | ---------------------------------------------------------- | ----------------- |
| `--kobe-font-sans`             | Everything (`font-sans`, chat root, consoles) | `system-ui, sans-serif`                                    | typeface / preset |
| `--kobe-font-mono`             | Code, file editor, context viewer             | `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace` | **fixed**         |
| `--kobe-brand-wordmark-size`   | The bar's app name                            | `1.125rem`                                                 | **fixed**         |
| `--kobe-brand-wordmark-weight` | The bar's app name                            | `600`                                                      | **fixed**         |

Typeface stacks (`FONT_STACK_VALUES` in `apps/web/lib/theme/presets.ts`): `system` =
`system-ui, sans-serif`; `humanist` =
`Seravek, "Gill Sans Nova", Ubuntu, Calibri, "DejaVu Sans", source-sans-pro, sans-serif`;
`grotesk` = `Inter, Roboto, "Helvetica Neue", "Arial Nova", "Nimbus Sans", Arial, sans-serif`;
`serif` = `Charter, "Bitstream Charter", "Sitka Text", Cambria, serif`. All system stacks: no font
files are loaded (`font-src 'self'` stays and nothing is shipped). Sizes, weights and line heights
are not themable.

## 6. Corners

| Token                | Used for                                     | sharp | soft (default) | round     |
| -------------------- | -------------------------------------------- | ----- | -------------- | --------- |
| `--kobe-radius-sm`   | Chips, badges, small controls (`rounded-sm`) | `0`   | `0.25rem`      | `0.5rem`  |
| `--kobe-radius-md`   | Buttons, inputs, menu items (`rounded-md`)   | `0`   | `0.375rem`     | `0.75rem` |
| `--kobe-radius-lg`   | Cards, panels, dialogs (`rounded-lg`)        | `0`   | `0.5rem`       | `1rem`    |
| `--kobe-radius-xl`   | Composer, artifact panel (`rounded-xl`)      | `0`   | `0.75rem`      | `1.25rem` |
| `--kobe-radius-pill` | The CSS modules' pill shapes (count pills)   | `0`   | `9999px`       | `9999px`  |

Tailwind's `--radius-sm` … `--radius-xl` map onto these in `apps/web/app/tailwind.css`, so existing
`rounded-*` utilities follow without edits; `rounded-full` stays Tailwind's (circles).

## 7. Shadows and scrims (fixed)

| Token                  | Used for                                       | Light and dark                   |
| ---------------------- | ---------------------------------------------- | -------------------------------- |
| `--kobe-shadow-pop`    | Menus, pickers, tooltips, the new-build banner | `0 4px 16px rgb(0 0 0 / 15%)`    |
| `--kobe-shadow-drawer` | The rail drawer and the artifact column edge   | `0 8px 24px rgb(0 0 0 / 12%)`    |
| `--kobe-shadow-panel`  | Workspace panels over the chat                 | `0 1.5rem 4rem rgb(0 0 0 / 25%)` |
| `--kobe-scrim`         | The drawer's full-window scrim                 | `rgb(0 0 0 / 40%)`               |

One value serves both themes (today's rendering); no preset sets them. Stylesheets read them
through `var(--kobe-shadow-…)`.

## 8. Rules every theme must meet

**Presets** are checked by `apps/web/lib/theme/presets.test.ts` in both schemes:

1. Body and muted text on page, panel and card: ≥ 4.5:1 (`--foreground`, `--muted-foreground`,
   `--kobe-console-fg`, `--kobe-console-muted`; the shadcn foreground/background pairs too).
2. Links (`--kobe-brand-link`) on page and panel: ≥ 4.5:1.
3. Primary fill text (`--kobe-brand-primary-fg` on `--kobe-brand-primary` and its hover): ≥ 4.5:1.
4. Focus colours (`--kobe-brand-focus`, `--kobe-composer-focus`, and `--ring` except in `default`)
   against page, panel and card: ≥ 3:1 (WCAG 1.4.11); control borders on page and panel likewise.
5. The fixed status, danger and tool-badge colours keep 4.5:1 on the preset's surfaces (§4.4).

**A custom accent** is checked by `checkFloor()` (`packages/protocol/src/theme/accent.ts`), the same
function on the Appearance page (Save stays off, with the first failure and its ratio) and on the
server (`PUT /v1/site/branding` answers 422 `contrast_floor` with every failure). In each scheme,
against the default surfaces of §4.1:

| Rule                                               | Pair                                             | Needs |
| -------------------------------------------------- | ------------------------------------------------ | ----- |
| `primary_on_surface`                               | the derived primary on the page and on the panel | 3:1   |
| `fg_on_primary`                                    | the primary fg on the primary                    | 4.5:1 |
| `fg_on_hover`                                      | the primary fg on the hover                      | 4.5:1 |
| `link on page`, `link on panel`                    | the derived link                                 | 4.5:1 |
| `focus on page`, `focus on panel`, `focus on card` | the derived focus colour                         | 3:1   |

A failure reports its rule, scheme, ratio (two decimals) and the required ratio. Presets are not
measured there (they pass by construction).

Always:

6. Colour never carries meaning alone: every status has a label or icon; a theme cannot remove them.
7. The two dark blocks in `theme.css` and in the rendered theme `<style>` are identical.

## 9. What cannot be themed, and why

- **Status, danger, confirm, tool, diff and context-viewer colours** (§4.4): meaning and
  colour-vision safety.
- **Shadows, the mono stack and the wordmark's type** (§5, §7): fixed in this release.
- **Layout**: rail widths (`--kobe-rail-width`, `--kobe-rail-room`, `--kobe-artifact-width`, declared in `components/shell/shell.module.css`, not theme.css),
  breakpoints, viewport variables, densities. They are behaviour, not style.
- **Artifact frames and MCP app frames**: sandboxed documents with their own CSP; the host's tokens
  do not reach them (an app may read `prefers-color-scheme` itself).
- **Isolation banner and the setup wizard's safety copy**: fixed wording and colours.
- **Per-team or per-user brand**: one organisation, one brand (TH1); members keep light/dark only.
- **Custom CSS, token overrides or font files** (v1): see TH2 and TH10 in the plan.

## 10. Adding or changing a token

1. Declare it in `apps/web/app/theme.css` with a light value on `:root` and the same dark value in
   both dark blocks (the test checks equality and that every dark token has a light value).
2. Map it in `apps/web/app/tailwind.css` (`@theme inline`) when a utility should read it.
3. Decide its column here: brand / preset / corners / typeface / fixed, and add it to
   `PRESET_SCHEME_TOKENS` and every preset in `presets.ts` when a preset sets it (`brandingCss()`
   checks its output against its allow-list and renders the defaults otherwise).
4. If it carries a contrast rule, add the pair to `theme-css.test.ts` and `presets.test.ts` and,
   where it reaches the screen, to `e2e/browser/tests/support/colours.ts`.
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
| `bg-brand-primary`, `hover:bg-brand-primary-hover`, `text-brand-primary-fg`, `text-brand-link`, `ring-brand-focus`, `outline-brand-focus`                                                                                                         | brand (§4.1)                              |
| `font-sans`, `font-mono`                                                                                                                                                                                                                          | typography (§5)                           |
| `rounded-sm`, `rounded-md`, `rounded-lg`, `rounded-xl`                                                                                                                                                                                            | corners (§6)                              |

Shadows have no Tailwind names; stylesheets read `var(--kobe-shadow-*)` (§7).

## 12. The Appearance page

_Site console → System → Appearance_ (`/admin/site/appearance`), for Owner and Admin (permission
`site.settings.manage`). Every change is one `site.branding.updated` site audit event per setting
([audit-log.md](audit-log.md)).

| Control                        | What it does                                                                                                                                                                                        |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Site name                      | The name (§2); applied with Save. Save stays off while the name breaks the rules.                                                                                                                   |
| Show the name next to the logo | `branding.show_name` (default on); applied with Save. Without a logo the name always shows; hidden, it stays the accessible name.                                                                   |
| Logo, Dark logo, Favicon       | Pick or drop a file; it is uploaded and applied at once (size cap checked in the browser, type and SVG rules by the server, its refusal shown verbatim). Remove deletes it. Dark logo needs a logo. |
| Style                          | The six presets (swatches) or Custom: accent colour (`#rrggbb` field and colour picker), Corners, Typeface. Applied with Save.                                                                      |
| Contrast line                  | Under Custom: the floor (§8) for the draft; Save stays off with the first failure and its ratio (cut to one decimal, never rounded up). A refused save lists the server's failures.                 |
| Preview                        | The draft in a light and a dark frame, as every page will show it (inert: a picture, not controls).                                                                                                 |
| Reset to Kobe defaults         | After a confirmation, removes the name, `show_name`, the style and all three files in one transaction, then re-seeds the chart's branding values if any are set (§13).                              |

Save sends only the settings that changed. After every save, upload, removal and reset the page
calls the web's `POST /api/branding/refresh` (same-origin only; 204), which drops that web
replica's branding cache and refetches at once, then reloads. **Other web replicas pick the change
up within 30 seconds** (their cache), and the server's own branding cache is 10 s per server replica
(the writing replica drops it at once).

### API

| Route                                   | Who                    | What                                                                                                                                                |
| --------------------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/site/branding`                 | public                 | `{appName, showName, logo: {url, dark?, width?, height?, darkWidth?, darkHeight?} \| null, favicon, theme}` with `ETag`, `Cache-Control: no-cache`  |
| `GET /v1/site/branding/assets/:kind`    | public                 | The file (§2 headers); 404 when none                                                                                                                |
| `PUT /v1/site/branding`                 | `site.settings.manage` | `{appName?, showName?, theme?}`, at least one; 400 invalid, 422 `contrast_floor`                                                                    |
| `PUT /v1/site/branding/assets/:kind`    | `site.settings.manage` | `multipart/form-data` with exactly one file; 411 without `Content-Length`, 413 over the cap, 415 not multipart or wrong type, 422 refused image/SVG |
| `DELETE /v1/site/branding/assets/:kind` | `site.settings.manage` | Removes the file; 404 when none                                                                                                                     |
| `POST /v1/site/branding/reset`          | `site.settings.manage` | Reset as above                                                                                                                                      |

Writes return the new `GET /v1/site/branding` body and pass the API's CSRF origin check.

## 13. Settings and chart-seeded defaults

Settings (`site_settings`): `branding.app_name` (the trimmed name), `branding.show_name` (`"true"` or
`"false"`; unset = true), `branding.theme` (JSON, §3). Files: `site_branding_assets` (`logo`,
`logo_dark`, `favicon`). Both are in every backup ([backup-restore.md](backup-restore.md)). An
unreadable stored value falls back to the default and is logged, never a failed page.

The chart can seed them for GitOps installs: `branding.appName`, `branding.preset` (one of the six
ids) and `branding.showName` (only `false` is passed on) become the server's `KOBE_BRANDING_*`
environment. At start the API server writes each set value **only while that setting is unset**
(audited as the system); an admin's change always wins and is never overwritten. Reset returns to
the chart's values at once; without chart values the keys stay unset (Kobe's defaults). Details in
[install.md](install.md#branding-and-theming).
