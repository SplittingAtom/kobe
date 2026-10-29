# KOBE-501: Theming T5: Appearance page in the Site console

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (group branch `group-theming-2`; not pushed)
- **Branch / worktree:** `kobe-501-appearance-page` in `../Kobe-wt501`
- **Depends on:** KOBE-497..500 (schema, tokens, branding API, themed first paint)

## Plan

Plan §6 in `docs/specs/theming.md` (TH2-TH4, TH8-TH12).

1. `lib/admin/api/site/branding.ts`: `getBranding`, `putBranding` (keeps a 422's `failures`),
   `uploadBrandingAsset` (multipart, field `file`), `removeBrandingAsset`, `resetBranding`.
2. `lib/theme/preview-css.ts` `previewCss(theme)`: scoped defaults + `brandingCss(theme, "#preview-*")`.
3. Nav `lib/admin/nav/site/appearance.ts` (System, order 25, minRole admin, READY);
   `app/admin/site/appearance/page.tsx`.
4. `components/admin/site/appearance-{page,identity,asset,style,preview,contrast}.tsx|ts`.
5. e2e `e2e/browser/tests/appearance.spec.ts`; `consoles.spec.ts` FIXED_PAGES gains the page;
   `support/colours.ts` gains `contrastOf`/`expectAA`; README section.

## Decisions

- **No change to `brandingCss`.** Its scope parameter already does it: the dark preview root has
  `data-theme="dark"`, so `#preview-dark[data-theme="dark"]` applies and the OS-dark block
  (`:not([data-theme="light"])`) never touches the light root (`data-theme="light"`).
- **Scoped defaults under the theme (`previewCss`).** brandingCss only overrides what a theme
  changes; without a base, the dark root would show the admin's own scheme's neutrals and status
  colours (default preset, custom accent). Each root first gets the default preset's values for
  its scheme, the three status chips' and danger colours, `--kobe-when-*` (dark logo swap), soft
  radii, system font, and theme.css's accent aliases (`--admin-accent`, `--kobe-status-accent*`):
  a custom property that reads another is resolved where declared, so the :root aliases would
  ignore the preview's brand. The fixed values are checked against theme.css in the test.
- **Nonced `<style>` in the browser only**: `useSyncExternalStore` reads `documentCspNonce()`
  (server snapshot null), so the style is never server-rendered without a nonce. No style
  attributes: preset swatches are SVG `<rect fill>` (presentation attributes).
- **Files apply on upload; name, "show the name" and style with Save.** Save PUTs only changed
  settings, then `window.location.reload()` (injectable `reloadPage` for tests); Reset asks
  (`useConfirm`) then reloads. Upload/remove update the page's copy of the branding (preview,
  swatches) without a reload, so a draft name is not lost.
- Save is disabled with a visible reason (`aria-describedby`) when the name breaks the schema,
  the hex is not `#rrggbb`, or `checkFloor` fails (first failure with its ratio). The server's 422
  failures are listed in the same words after a refused save.
- Contrast line ratios are cut to one decimal, never rounded up (4.47 reads 4.4). Failure wording
  per rule in `appearance-contrast.ts`; unknown rules fall back to the rule name.
- Client checks only the size cap before uploading; type and SVG content are the server's
  (message shown verbatim; `svg_refused` adds "Export the file as Plain SVG (Inkscape's own
  format is refused)."). `accept` lists the per-kind content types plus their extensions.
- Logo shown on a light and a dark swatch (`data-kobe-swatch`, given each scheme's default
  tokens by `previewCss`: the tokenization guard forbids palette classes and colour literals in
  components); the dark logo field shows only the dark swatch; favicon at 16 and 32 px.
- The preview roots are `inert` (a picture, not controls).
- e2e polls a fresh server render (`page.request.get("/")`) for each change: the web caches the
  branding 30 s (TH5, stale-while-revalidate), so the reload right after Save may still show the
  old values for one cache period. The spec resets the site in `finally`.

## Open questions (for Chris or the coordinator)

- **Screenshot baseline:** the first CI/gate run of `consoles.spec.ts` needs
  `--update-snapshots` for the new page only (`admin-site-appearance` in light, dark).
- KOBE-500's open question (branded `<style>` after theme.css in a real `next start`) is checked
  by appearance.spec.ts's Plum step on gate1 (AA and themed paint in both themes).
- ac-3 ("clean SVG served with TH8 headers") and ac-4 (audit rows) are server behaviour covered
  by KOBE-499's `site-branding.db.test.ts`; this page adds no server code.

## Evidence (acceptance criteria → test or command output)

- ac-1: `appearance-page.test.tsx` (save body = changed settings only, reload), `appearance-parts.test.tsx`
  (uploads, preview); e2e `appearance.spec.ts` (title, bar h1, header img, link rel=icon in a
  fresh server render).
- ac-2: `appearance-page.test.tsx` (Save disabled with the ratio; server 422 failures shown),
  `appearance-contrast.test.ts`; server: KOBE-499.
- ac-3: `appearance-parts.test.tsx` (refusal verbatim + Plain SVG hint); e2e `<script>` SVG.
- ac-4: server (KOBE-499 db test); the page uses only the audited routes.
- ac-5: needs gate1 (Playwright, CI only).
