# Kobe — Site theming and branding (plan)

Status: **decisions by Chris, 2026-10-28** (TH1–TH12 binding; TH9 amended to six presets with the
default called `default`). Tickets T1–T9 are filed as KOBE-497–505 (T1 = KOBE-497 … T9 = KOBE-505; label `theming`). Companion document:
[`docs/theming.md`](../theming.md), the catalogue of everything a theme can change (the target
state this plan builds; since it shipped it records what is actually there).

## Shipped (2026-10-29)

| Tickets                                                              | PR                        |
| -------------------------------------------------------------------- | ------------------------- |
| KOBE-497 (T1 schema), KOBE-498 (T2 tokens)                           | #400 (wave 1)             |
| KOBE-499 (T3 API), KOBE-500 (T4 first paint)                         | #401 (wave 2)             |
| KOBE-501 (T5 page), KOBE-502 (T6 docs), KOBE-503 (T7 chart defaults) | wave 3 PR (501, 502, 503) |

T8 (KOBE-504) and T9 (KOBE-505) are not built. Decisions made during implementation (the plan
below is kept as written; where it differs, these and [`docs/theming.md`](../theming.md) win):

- **Per-scheme derived accent** (refines TH4): the light primary is the accent as given; the dark
  primary is the accent lightened until 3:1 on the dark page and panel; text on it is white or
  `#111111`, whichever contrasts more; link and focus are derived per scheme. `checkFloor()` checks
  fill on surface (3:1), text on fill and hover (4.5:1), link on page and panel (4.5:1) and focus on
  page, panel and card (3:1) in both schemes. Presets set `--ring` and `--kobe-composer-focus` too.
- **SVG rule** (extends TH8): `url(#id)` references inside the image are allowed (gradients, masks);
  only the SVG and xlink namespaces are accepted (Inkscape users save as Plain SVG); DOCTYPE,
  entities, processing instructions, HTML-ish elements and CSS escapes are refused as well.
- **`branding.show_name`** (new setting): whether the header shows the name next to the logo
  (default true; audited as `show_name`).
- **`KOBE_SERVER_URL` defaults to the server Service** `http://<fullname>-server` (port 80, not
  `:8080` as TH5 said); `web.serverUrl` overrides it for split installs; an invalid value fails the
  web's start. The web cache is stale-while-revalidate (30 s).
- **Reset re-seeds the chart values** (KOBE-503): `POST /v1/site/branding/reset` returns to the
  chart's `branding.*` values in the same transaction, or to Kobe's defaults without them.
- **Refresh route**: the web's `POST /api/branding/refresh` (same-origin) drops that replica's
  cache after every change on the Appearance page; other replicas follow within 30 s.

## 1. Summary

A site admin (Owner or Admin, permission `site.settings.manage`) gets an **Appearance** page in the
Site console to:

1. name the web application (replaces "Kobe" in the bar, page titles, sign-in, setup and invite
   pages);
2. upload a logo for the upper-left corner (optional dark variant);
3. upload a favicon;
4. apply a style: a shipped preset, or an accent colour, corner style and typeface, previewed live
   in both light and dark.

Underneath, the UI is finished off as a **tokenized design system**: every colour, radius, font and
shadow the pages use comes from one named token in `apps/web/app/theme.css`, with a guard test that
keeps it that way. A theme is then nothing more than a small, validated set of token values the web
renders into one nonced `<style>` on every page, so the first paint is already themed (no flash of
the default brand) and the CSP stays as strict as it is today.

Nothing in the agreed spec (D1–D32) speaks to branding; D9 only fixes the brand's place (top-left).
This is additive site-level configuration, like required 2FA or retention.

## 2. What exists today (survey of `main` 3527a448)

- **Tokens.** `apps/web/app/theme.css` (KOBE-282) is already the single source: ~80 colour tokens
  on `:root`, dark values twice (chosen dark, OS dark; the two blocks must match, enforced by
  `app/theme-css.test.ts`). `app/tailwind.css` maps them to Tailwind colour utilities. Status,
  tool-badge, confirm, diff and context-viewer palettes are tokens with documented WCAG rules.
- **Gaps for theming.** Two neutral palettes live side by side (shadcn `--background …` for the chat
  and `--kobe-console-*` for the consoles and My area), bridged by `--admin-*` aliases that are
  defined inside `chat.module.css` rather than on `:root` (the rail and icon modules carry hard-coded
  fallbacks for them). No token exists for the brand accent as such: blue is spelled twice
  (`--admin-accent`, `--kobe-status-accent`). Typography (5 literal `font-family` declarations),
  corner radii (Tailwind scale and literal `border-radius`), shadows and scrims (10 literal
  `rgb(0 0 0 / …)` values) and the wordmark's size are not tokens. Only 2 Tailwind default-palette
  colour classes remain (`text-amber-*`), so the colour debt is small.
- **Brand surface.** The wordmark is a literal `<h1>Kobe</h1>` in `components/shell/utility-bar.tsx`;
  the consoles and My area render `<ChatReturnLink>Kobe</ChatReturnLink>` in
  `components/admin/console-shell.tsx` and `components/me/my-agents-shell.tsx`. Page titles are
  `"<page> · Kobe"` in five `metadata` exports. Sign-in, setup, invite and forgot-password pages say
  "Kobe" in copy. `apps/web/public/` is empty: there is **no favicon at all** today.
- **Settings and storage.** `site_settings` (key/value text, `PUT /v1/site/settings`, audited as
  `site.settings.updated`) holds site-wide switches. Binary content in Postgres uses the `bytea`
  custom type (skill drafts). Uploads are multipart with explicit size caps (`workspace-files.ts`).
  ETag handling exists in the gallery and skill-draft routes.
- **Delivery constraints.** The web pod talks to the server only from the browser, same-origin via
  the ingress (`/v1` → server). It has **no server URL and no server-side fetch** today, so nothing
  branded can reach the first paint without adding one. CSP (`lib/security/csp.ts`):
  `style-src 'self' 'nonce-…'`, `img-src 'self' data:`, `font-src 'self'`. The root layout already
  renders per request and already injects a nonced style for Radix (`StyleNonce`), so a nonced
  theme `<style>` fits the existing pattern.
- **Tests that theming touches.** `theme-css.test.ts` (token contract), `e2e/browser/tests/theme.spec.ts`
  (both themes paint, AA contrast via `support/colours.ts`), `consoles.spec.ts` (screenshot
  baselines of every console page in light and dark: any pixel change needs
  `--update-snapshots`).

## 3. Decisions (Chris, 2026-10-28)

**TH1. Site-wide, not per team.** One organisation, one brand (the product's premise). Teams get no
theme of their own. Members keep their personal light/dark choice (KOBE-282); a theme defines both.

**TH2. Four inputs, no raw CSS.** Admins set: app name; logo (+ optional dark logo); favicon; style =
preset **or** (accent colour, corners, typeface). No custom CSS, no arbitrary token editing in v1
(T8 adds allow-listed token overrides later). Raw CSS would let an admin exfiltrate page content
through `url()` and undo the accessibility floor; presets and a gated accent cannot.

**TH3. Brand accent drives everything that is blue today; neutrals stay neutral.** The accent sets
links, focus rings, console primary buttons, accent badges and count pills (`--admin-accent`,
`--kobe-status-accent*`, `--ring`, `--kobe-composer-focus`). Page, panel, card and text neutrals are
unchanged by the accent; a preset may retint them. The chat's shadcn `--primary` (assistant-ui's
send button) stays neutral. Status colours (running/attention/failed/done/idle), danger, confirm,
tool badge, diff and context-viewer kinds are **never** themable: they carry meaning and have
tuned contrast in both themes.

**TH4. Accessibility floor is enforced, not advised.** The accent's foreground is chosen
automatically (white or near-black, whichever is higher contrast); saving is refused, by the page
and by the server, when the accent cannot reach 4.5:1 with either on the page and panel backgrounds
in **both** themes, or when the derived link colour falls under 4.5:1 on the page. The same
function (`packages/protocol` or `apps/web/lib/theme/contrast.ts`) runs in both places. The e2e
contrast checks in `theme.spec.ts` run against the themed site too.

**TH5. The theme reaches the first paint through the server render.** The web pod gets
`KOBE_SERVER_URL` (chart default `http://<release>-server:8080`, in-cluster; the existing
`not-from-sandboxes` NetworkPolicy already admits other Kobe pods on 8080, no new policy). The root
layout fetches `GET /v1/site/branding` with a 1 s timeout and a 30 s in-process cache, and falls
back to the built-in Kobe defaults when the server is unreachable (logged once per minute, never a
failed page). The theme becomes one nonced `<style>` in `<head>` holding only token declarations;
the name and asset URLs go into `generateMetadata` and a React context. No client-side flash, no
extra render-blocking request, no change to the CSP.

**TH6. Branding is public.** `GET /v1/site/branding` and the asset routes need no session: the
sign-in page must already show the name, logo and favicon. They expose the organisation's name and
logo, which the sign-in page shows anyway. They are cheap (server memory cache 10 s, ETag,
immutable asset URLs) and carry no other data.

**TH7. Assets live in Postgres, not S3.** Two or three small files (logo ≤ 512 KiB, dark logo ≤ 512
KiB, favicon ≤ 256 KiB) in a site table `site_branding_assets` (`bytea`), served by the server with
`ETag`, `Cache-Control: public, max-age=31536000, immutable` when fetched with `?v=<sha256>`.
Backups cover them automatically (the dump takes every `public` table); S3 would add a dependency
to the sign-in page for no gain.

**TH8. Accepted formats and the SVG rule.** Logo: PNG, JPEG, WebP, SVG. Favicon: PNG, SVG, ICO
(the browser picks sizes from one file; no generated size set in v1). Type is detected from the
bytes (magic numbers; SVG parsed as XML), never trusted from the upload's content type. An SVG is
**refused**, with the reason, when it contains `<script>`, any `on*` attribute, `<foreignObject>`,
an external `href`/`xlink:href` (anything but `#fragment`), or `url(` inside a `<style>` or
attribute. Refusal beats sanitising: the admin sees exactly why, and no sanitiser bug ships. Assets
are served `X-Content-Type-Options: nosniff` with
`Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox`, and used only
as `<img>`/`<link rel=icon>` sources, which never run script.

**TH9. Shipped presets.** (Chris) Six: `default` (today's neutral look; the built-in default),
`slate`, `forest`, `plum`, `ember`, `tokyo-nights`. Each has full light and dark values and passes
the floor (TH4) by construction (a unit test asserts it). A preset is a named set of token values in
`apps/web/lib/theme/presets.ts`; its id list is in `packages/protocol` so the server validates it.
Display names: Default, Slate, Forest, Plum, Ember, Tokyo Nights.

**TH10. Typeface choice is a stack, not a file.** `system` (today's `system-ui`), `humanist`,
`grotesk`, `serif`: four system font stacks. No font uploads in v1 (`font-src 'self'` stays; a
later ticket may allow WOFF2 uploads through the same asset table).

**TH11. Corners: `sharp`, `soft` (today), `round`.** Three radius scales mapped onto
`--kobe-radius-*`, which Tailwind's `rounded-*` utilities and the CSS modules both read after T2.

**TH12. Reset and audit.** "Reset to Kobe defaults" removes the name, assets and style in one
transaction. Every change is one `site.branding.updated` audit event per setting (`app_name`,
`theme`, `logo`, `logo_dark`, `favicon`; the value is the label or the asset's sha256, never the
bytes). Owner and Admin can both change it (permission `site.settings.manage`; nothing here weakens
security, so no Owner-only step).

## 4. Architecture

### 4.1 Data

- `site_settings` keys (existing table): `branding.app_name` (1–40 characters, plain text, trimmed),
  `branding.theme` (JSON, schema `themeSettingsSchema` in `packages/protocol/src/branding.ts`:
  `{ preset: PresetId } | { preset: "custom", accent: "#rrggbb", corners: Corners, font: FontStack }`).
  An unreadable value falls back to the default and is logged (never a failed page).
- New site table `site_branding_assets` (`packages/db/src/schema/branding.ts`, registered in the
  site tables of `tenancy/identity.ts` with grants SELECT/INSERT/UPDATE/DELETE; no `team_id`, like
  `site_settings`): `kind text primary key check (kind in ('logo','logo_dark','favicon'))`,
  `bytes bytea not null`, `content_type text not null`, `sha256 text not null`, `byte_size int`,
  `width int`, `height int` (null for SVG/ICO), `updated_at`, `updated_by uuid references users`.
  One migration, alone (parallel-work rule).

### 4.2 Server (`services/server/src/routes/site-branding.ts`)

| Route                                   | Auth                   | Notes                                                                                                                                   |
| --------------------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/site/branding`                 | none                   | `{ appName, logo: {url, dark?: url} \| null, favicon: url \| null, theme }`; URLs carry `?v=<sha256>`; `ETag` over the JSON, 10 s cache |
| `GET /v1/site/branding/assets/:kind`    | none                   | bytes with real content type; `immutable` when `?v` matches, else `no-cache` + `ETag`; headers per TH8                                  |
| `PUT /v1/site/branding`                 | `site.settings.manage` | name and/or theme; validation (zod, contrast floor TH4); audited                                                                        |
| `PUT /v1/site/branding/assets/:kind`    | `site.settings.manage` | multipart, one file; `Content-Length` cap before reading; sniff + SVG rule; audited with the sha256                                     |
| `DELETE /v1/site/branding/assets/:kind` | `site.settings.manage` | audited                                                                                                                                 |
| `POST /v1/site/branding/reset`          | `site.settings.manage` | TH12                                                                                                                                    |

Mounted next to `/site/settings` in `app.ts`; the two public GETs are registered before the auth
middleware the same way `/v1/setup` is, and go through `auditRequestContext` only (they write
nothing). State-changing routes inherit the existing CSRF origin check.

### 4.3 Web

- `apps/web/lib/theme/branding-server.ts`: `getSiteBranding()` (TH5) — fetch, timeout, cache,
  fallback `DEFAULT_BRANDING` (name "Kobe", no assets, preset `default`).
- `apps/web/lib/theme/branding-css.ts`: `brandingCss(theme, scope = ":root")` → the three blocks
  (`:root`, `:root[data-theme="dark"]`, `@media (prefers-color-scheme: dark) :root:not([data-theme="light"])`)
  with **only** `--kobe-brand-*`, `--kobe-radius-*`, `--kobe-font-*` declarations, values produced by
  the preset table or by `deriveAccent()` (hover = accent darkened one step, foreground per TH4,
  link = accent adjusted to 4.5:1 on each theme's page). Never interpolates free text; a unit test
  asserts the output matches `^[\s\w:;{}()#.,%/@"=\[\]-]*$` and that the two dark blocks are equal.
- `app/layout.tsx`: `generateMetadata()` → `title: { default: appName, template: "%s · " + appName }`,
  `icons` from the favicon URL (or the shipped `app/icon.svg`, new: the repo has none);
  `<style nonce={x-nonce}>{brandingCss(theme)}</style>`; `<BrandingProvider value={branding}>`.
  The five `metadata` exports with `"… · Kobe"` become `title: "Site console"` etc. and get the
  suffix from the template.
- `components/shell/brand.tsx`: `<Brand />` — logo `<img>` (24 px tall, max 160 px wide, `alt=""`
  next to the visible name, `alt={appName}` when the name is hidden) plus the name; swaps to the dark
  logo via `--kobe-when-dark/light` (two `<img>` tags, like the theme toggle's icons). Replaces the
  `<h1>Kobe</h1>` wordmark and the two `<ChatReturnLink>Kobe</ChatReturnLink>` brand slots. Sign-in,
  setup, invite, forgot/reset pages read `useBranding().appName` for their copy.
- Nav: `lib/admin/nav/site/appearance.ts` (`group: "System"`, `order: 25`, `minRole: "admin"`),
  page `app/admin/site/appearance/page.tsx`, component `components/admin/site/appearance-page.tsx`.

### 4.4 Chart and dev loop

- `charts/kobe`: web Deployment env `KOBE_SERVER_URL: http://{{ fullname }}-server:8080`
  (overridable in values for split installs); NOTES mention Appearance. Tilt (kobe-dev) gets the same.
- No new dependency planned: colour math (hex → sRGB → relative luminance, WCAG ratio, a darken
  step) is ~60 lines with tests. If a library is preferred, `culori` is MIT (then
  `pnpm licenses:update`).

## 5. Tokenization (ticket T2, the enabler)

Goal: a theme changes **only** `theme.css` values; every other stylesheet and component reads
tokens. Steps, all in `apps/web`:

1. **Brand layer.** Add `--kobe-brand-primary`, `--kobe-brand-primary-hover`, `--kobe-brand-primary-fg`,
   `--kobe-brand-link`, `--kobe-brand-focus` with today's blues as values, and point the existing
   tokens at them: `--admin-accent: var(--kobe-brand-link)`, `--kobe-status-accent: var(--kobe-brand-primary)`,
   `--kobe-status-accent-fg: var(--kobe-brand-primary-fg)`, `--ring` and `--kobe-composer-focus` →
   `--kobe-brand-focus` (chat `--ring` stays neutral-grey by default: the `default` preset keeps today's
   values exactly, so no screenshot changes).
2. **Typography tokens.** `--kobe-font-sans`, `--kobe-font-mono`; Tailwind `--font-sans`/`--font-mono`
   mapped in `@theme inline`; the five literal `font-family` declarations read them; the wordmark's
   size/weight become `--kobe-brand-wordmark-size`/`-weight`.
3. **Radius tokens.** `--kobe-radius-sm|md|lg|xl|pill`; Tailwind `--radius-*` mapped to them;
   literal `border-radius` in CSS modules replaced.
4. **Shadow and scrim tokens.** `--kobe-shadow-pop`, `--kobe-shadow-drawer`, `--kobe-shadow-panel`,
   `--kobe-scrim` replace the ten literal `rgb(0 0 0 / …)` values; dark values tuned to today's look.
5. **Aliases to `:root`.** Move `--admin-fg/muted/bg/panel/border` from `chat.module.css .app` to
   `theme.css` (same values); delete the hard-coded fallbacks in `rail.module.css`,
   `icon-action.module.css`, `context-gauge.module.css`. Rename later if wanted; the catalogue
   documents them as legacy aliases.
6. **Guard.** Extend `theme-css.test.ts`: outside `theme.css` no colour literal (`#hex`, `rgb(`,
   `oklch(`, `hsl(`), no `font-family` literal, no `box-shadow` with a colour literal, no Tailwind
   default-palette colour class in `.tsx` (the two `text-amber-*` become `text-status-attention`).
   Every brand/radius/font token is mapped in `tailwind.css`. The console screenshot baselines
   must **not** change in T2 (computed values are identical); CI's `consoles.spec.ts` is the proof.

The two neutral palettes (chat shadcn vs console hex) stay in v1 and both follow the brand layer;
unifying them is T9 (optional, visual change, new baselines).

## 6. Appearance page (ticket T5)

- **Identity**: name field (counter, 40 max, live example "Site console · <name>"); logo upload
  (drag/drop or pick; shows the current one on light and dark backgrounds; optional dark variant;
  Remove); favicon upload (preview at 16 and 32 px; Remove). Errors name the rule that failed
  (size, format, SVG content) in the admin's words.
- **Style**: preset cards with a swatch strip (page, panel, accent, text) in both themes; Custom:
  accent (hex field + native colour input), Corners and Typeface choice groups; a live contrast
  line ("Accent text: white, 7.2:1 light / 6.1:1 dark") and a disabled Save with the reason when
  under the floor.
- **Preview**: a mini shell (bar with `<Brand>`, a primary button, a link, three status chips, a
  card with a form control) rendered twice, light and dark, styled by `brandingCss(theme, "#preview-light")`
  scoped to the preview roots, so it is the real CSS, not an approximation.
- Save (PUT), Reset to defaults (confirm dialog), `MutationStatus` as on the Settings page. After a
  save the page reloads itself so the admin sees the real header and title; other members pick it
  up within 30 s (TH5 cache) on their next navigation, and the new-build banner (KOBE-487) is not
  involved.

## 7. Security review points

- Public GETs (TH6): read-only, cached, no personal data; assets served with nosniff + sandboxing
  CSP (TH8); `?v` immutable caching only when the hash matches the stored one.
- Uploads: admin only; `Content-Length` checked before the body is read; magic-byte sniffing;
  SVG refusal rules; dimensions parsed for PNG/JPEG/WebP (cap 4096 px) so a decompression bomb
  cannot reach the browser at 512 KiB anyway; stored bytes are what is served, byte for byte.
- CSS injection: `brandingCss` takes typed values only (hex validated by regex, enums for the rest);
  the app name never enters CSS; React escapes it in markup; the `<title>` template is Next's.
- Nonce: the theme `<style>` gets the request nonce from `x-nonce` (as `StyleNonce` does); the CSP
  does not change; `theme-css.test.ts` continues to guard that no stylesheet switches on the OS
  setting itself.
- Audit, CSRF and permissions follow the Settings route exactly; nothing weakens with a theme.
- Server-side fetch (TH5) targets a fixed in-cluster URL from config (zod `url`), never a value
  from a request; failure degrades to defaults.

## 8. Tickets

Sizes S/M/L as in the wave plans; "Review" names the reviewer model per `docs/agent-prompt.md`.

| #             | Title                                                                                                                                                                                                                                                                                                        | Size | Depends                        | Review                          |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- | ------------------------------ | ------------------------------- |
| T1 (KOBE-497) | **Branding schema + contract**: `site_branding_assets` migration (alone), tenancy registration, `packages/protocol/src/branding.ts` (types, zod, preset ids, limits), audit event `site.branding.updated`, `site_settings` keys                                                                              | S    | —                              | Opus (DB/RLS)                   |
| T2 (KOBE-498) | **Tokenize the UI**: brand/typography/radius/shadow tokens, aliases to `:root`, Tailwind mapping, guard test, zero baseline change (§5)                                                                                                                                                                      | M    | —                              | Sonnet                          |
| T3 (KOBE-499) | **Branding API**: public GET JSON + assets with ETag/immutable, admin PUT/DELETE/reset, sniffing + SVG rule, contrast floor, audit, server cache; `*.db.test.ts` + route tests                                                                                                                               | M    | T1                             | Opus (public endpoint, uploads) |
| T4 (KOBE-500) | **Themed first paint**: `KOBE_SERVER_URL` (chart, Tilt, web config), `getSiteBranding()`, `brandingCss()`, `generateMetadata` titles + icons, nonced style, `BrandingProvider`, `<Brand>` in bar/consoles/My area, auth pages' copy, shipped default `icon.svg`; presets + `deriveAccent()` with floor tests | M    | T1, T2 (contract only from T3) | Sonnet                          |
| T5 (KOBE-501) | **Appearance page**: nav entry, identity + style + preview, uploads, contrast line, reset; e2e `appearance.spec.ts` (rename → title and bar; logo → header `<img>`; favicon → `<link rel=icon>`; preset → AA in both themes via `support/colours.ts`); console screenshot baseline for the new page          | L    | T3, T4                         | Sonnet                          |
| T6 (KOBE-502) | **Docs**: finalise `docs/theming.md` (mark shipped), `docs/install.md` (`KOBE_SERVER_URL`, split installs), `docs/backup-restore.md` (assets table in the dump, restore smoke check), chart NOTES, README screenshot                                                                                         | S    | T5                             | Haiku                           |
| T7 (KOBE-503) | _(optional)_ **Chart-seeded defaults**: `branding.appName`/`branding.preset` values applied as a startup seed only while unset (GitOps installs); `startup-seeds.ts` registration                                                                                                                            | S    | T3                             | Sonnet                          |
| T8 (KOBE-504) | _(optional)_ **Advanced overrides**: allow-listed token overrides (the catalogue's "override" column) with the same floor; export/import theme JSON                                                                                                                                                          | M    | T5                             | Sonnet                          |
| T9 (KOBE-505) | _(optional, later)_ **One neutral palette**: consoles read the shadcn neutrals; new console baselines                                                                                                                                                                                                        | L    | T2                             | Sonnet                          |

Acceptance criteria to carry into Hadron (the gate checks them on kobe-gate1):

- ac-1: with nothing configured the site looks and titles exactly as today (baselines unchanged after T2 and T4).
- ac-2: an admin sets name, logo, favicon and a preset; a signed-out visitor's sign-in page and a member's first paint show all four with no flash (Playwright: no frame where the bar reads "Kobe").
- ac-3: an accent that cannot meet 4.5:1 is refused by the page and by `PUT` (422 with the ratio).
- ac-4: an SVG with a `<script>` or `onload` is refused with the reason; a clean SVG logo is served with the TH8 headers.
- ac-5: every change appears in the site audit log with the setting name and label/hash.
- ac-6: `pnpm verify`, the cross-team probe suite and `theme.spec.ts` stay green with a non-default preset active.
- ac-7: `kobe backup` + `kobe restore` carry the assets and settings.

## 9. Waves (2 lanes, migrations alone)

- **W1:** T1 (migration PR, alone in its lane) ∥ T2 (web only, no migration).
- **W2:** T3 ∥ T4 (T4 builds on T1's contract and stubs the fetch; integrates once T3 merges).
- **W3:** T5.
- **W4:** T6 ∥ T7. Gate review with Chris: TH decisions, preset names, screenshots of the five
  presets in both themes, `pnpm license:gate`.
- **Later:** T8, T9 as wanted.

## 10. Test plan

- Unit (web): `branding-css.test.ts` (structure, equality of dark blocks, character allow-list,
  scoping), `contrast.test.ts` (known WCAG pairs), `presets.test.ts` (every preset meets the floor
  in both themes), `brand.test.tsx` (logo/name/dark-variant render, accessible name),
  `theme-css.test.ts` extensions (§5.6), `branding-server.test.ts` (timeout, cache, fallback).
- Unit/integration (server): route tests for every row of §4.2 (auth, validation, 413 before read,
  sniffing fixtures for each format, SVG refusal cases, ETag/304, immutable only on a matching
  `?v`), `site-branding.db.test.ts` (grants, reset transaction, audit rows), cross-team probe suite.
- E2E (browser, gate1): `appearance.spec.ts` (ac-2…ac-4), `theme.spec.ts` under a non-default
  preset, `consoles.spec.ts` baseline for the Appearance page.
- Coverage stays at the repo's 80% floor; `pnpm verify` plus `@kobe/server test:db`.

## 11. Risks

- **Chat primary button** (TH3, decided neutral): if the mix of a neutral send button and accent
  console buttons reads as inconsistent on gate1, the reversal is one line (`--primary` →
  `--kobe-brand-primary`), reviewed with Chris at the gate.
- **Email templates**: `services/server/src/mail/messages.ts` says "Kobe" in the invitation,
  password-reset and scheduled-run mails (four strings). T3 adds a `readAppName()` helper over
  `site_settings` and the mailer reads it, so mails follow the name; no extra ticket.
- **Split installs** where web and server are not in one release need `KOBE_SERVER_URL` set; the
  chart default covers the normal case. Without it the web degrades to defaults and logs.
- **Baseline churn**: T2 must leave every console screenshot identical; the `default` preset reproduces
  today's values byte for byte, which the test proves before any theme feature lands.
- **ICO favicons** are served as-is (no parsing beyond the magic bytes and a size cap).

## 12. Out of scope (v1)

Per-team themes; custom CSS; font file uploads; generated favicon size sets and PWA manifest
icons; theming of the sandbox-rendered artifact frames and MCP app frames (they have their own
CSP and no access to the host's tokens); dark-only or light-only sites (members keep the toggle).
