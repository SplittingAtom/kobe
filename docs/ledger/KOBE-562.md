# KOBE-562: Branding: themed logo via the Appearance upload (inline SVG takes currentColor; theme-aware SVG favicon)

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (PR pending)
- **Branch / worktree:** `kobe-562-themed-logo` in `../Kobe-wt562`
- **Depends on:** none. **Supersedes KOBE-561** (no shipped monster artwork; Chris 2026-11-07):
  the uploaded logo takes the theme colour instead.

## Plan

1. Protocol: `branding.logo_theme_color` (default off), `logoThemeColor` and `logo.inline` in the
   public branding.
2. Server: inline-safe variant and themed favicon derived from the §2.1 reader's own walk; settings,
   PUT, audit, reset, OpenAPI; variants served by hash with the asset headers.
3. Web: `<Logo>` (components/shell/logo.tsx), `<Brand>` inlines it when the branding names a variant;
   `.themed` token styles; the server render fetches and re-checks the markup.
4. Appearance: the switch, the raster note, the dark-logo note; docs.

## Decisions

- **One reader.** `checkSvg` gained an optional `SvgSink` (open/close/text events as it reads);
  `services/server/src/branding/svg-themed.ts` rebuilds the variant from those events with an
  element/attribute allowlist and escapes every value. A refusal anywhere fails the derivation,
  so §2.1 applies first. Nothing is patched in place.
- **Variant derived on read, not stored.** The snapshot derives it from the stored bytes (memoised
  per replica by source sha256, 16 entries), so no migration and no stored copy to keep in step;
  its URL carries the variant's own sha256 (a code change to the derivation changes the URL, so the
  immutable cache never serves a stale variant).
- **`a`/`switch` become `g`** (content kept, link dropped); `title`/`desc` are dropped (the logo
  is decorative beside the name). Root width/height dropped; viewBox derived from them if missing.
- **Defence in depth on the web:** `lib/theme/inline-logo.ts` refuses markup that is not the
  server's shape (one `<svg xmlns=SVG>` root; no script/style/handlers/style attributes/external or
  unprefixed refs/unprefixed ids; ≤ 1 MiB); `<Logo>` checks again before `dangerouslySetInnerHTML`.
  If the markup cannot be had, the loader drops `inline` and the logo shows as `<img>` (logged,
  rate-limited).
- **Preview:** the admin API's branding has only the URL, so `<Brand>` fetches the variant in the
  browser there (once per URL), showing the `<img>` until it arrives. The switch is applied with
  Save (like "Show the name"); the preview shows the themed logo once saved ("Save to see it in the
  preview." while the draft differs).
- **Raster hint:** the branding does not carry the logo's type, so the switch's hint always says
  only an SVG can take it; with the setting saved on and a logo without `inline` the page says
  "This logo is not an SVG, so it shows as uploaded."
- **Dark logo:** while the logo is inline the public branding leaves `dark` out; the Dark logo field
  probes the stored file (as for a dark logo without a logo) so it stays visible with Remove, and
  notes it is kept but not used.
- **Active colour:** "accent" is read as the brand link accent `--admin-accent`
  (`var(--kobe-brand-link)`); shadcn's `--accent` is a neutral surface, not a colour for marks.
- **Protocol change inside the feature PR:** `logoThemeColor` defaults to false when absent (a new
  web against an old server parses); the field is additive.
- Not chart-seeded (no `branding.logoThemeColor` chart value): not asked for.

## Open questions (for Chris or the coordinator)

- None blocking. Gate1 check (ac-6, last part) is the coordinator's: turn the setting on with
  Chris's logo, check light, dark, theme switch, hover, favicon in light/dark tabs.

## Evidence (acceptance criteria → test or command output)

- ac-1: `packages/protocol/src/branding.test.ts` (key, default, schema);
  `services/server/src/site-branding.db.test.ts` "Logo takes the theme colour (KOBE-562)" (PUT,
  audit `logo_theme_color`, 403, reset); `services/server/openapi.json` (`getSiteBranding`,
  `putSiteBranding`, `getSiteBrandingAsset`); `apps/web/components/admin/appearance-parts.test.tsx`
  and `appearance-page.test.tsx` (switch, raster note, dark-logo note, save).
- ac-2: `services/server/src/branding/svg-themed.test.ts` (style injection, id collision, external
  href and other §2.1 refusals, gradient/pattern paints, allowlist, escaping, plain monochrome logo,
  output re-accepted by the reader); `store.test.ts`; DB test serves the variant immutable by its
  hash with nosniff and the sandbox CSP.
- ac-3: `apps/web/components/shell/logo.test.tsx`, `brand.test.tsx` (inline path, SSR, browser
  fetch, `<img>` path unchanged, accessible name); `lib/theme/inline-logo.test.ts`,
  `lib/theme/branding-server.test.ts`; `app/theme-css.test.ts` green (no colour literal).
- ac-4: `svg-themed.test.ts` "themedFaviconSvg"; DB test "serves an SVG favicon with the scheme
  style when on; PNG unchanged".
- ac-5: `docs/theming.md` §2 (Favicon row, new Logo theme colour row, variant URLs), §2.1 (inline
  variant), §12 (control, API), §13 (setting); `docs/audit-log.md`, `docs/backup-restore.md`.
- ac-6: `pnpm verify` (see PR); CI on the PR; gate1 check by the coordinator.
