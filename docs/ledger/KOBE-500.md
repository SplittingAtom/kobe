# KOBE-500: Theming T4: themed first paint

- **Status:** in review (group branch `group-theming-1`, not pushed)
- **Branch / worktree:** `kobe-500-themed-first-paint` in `../Kobe-wt500`
- **Depends on:** KOBE-497 (contract), KOBE-498 (tokens); KOBE-499's protocol maths cherry-picked

## Plan

Plan §4.3, §4.4, TH3, TH5, TH9-TH11 in `docs/specs/theming.md`; catalogue `docs/theming.md`.

1. Chart/Tilt/web config: `web.serverUrl` -> `KOBE_SERVER_URL` on the web Deployment;
   `apps/web/lib/config.ts` (zod url, origin only, never throws); `instrumentation.ts` logs it once.
2. `lib/theme/branding-server.ts` `getSiteBranding()`: 1 s timeout, 30 s cache (failures too),
   one shared in-flight request, defaults on any failure, a log line at most once a minute.
3. `lib/theme/presets.ts`: six presets, font stacks, radius scales.
4. `lib/theme/branding-css.ts` `brandingCss(theme, scope)`.
5. `app/layout.tsx`: `generateMetadata` (title template, favicon), nonced `<style>` only when
   non-empty, `BrandingProvider`; `app/icon.svg`; four page titles drop " · Kobe".
6. `components/shell/brand.tsx` in the bar and both console brand links; auth pages' copy.

## Decisions

- **Default server URL is `http://<fullname>-server` (port 80), not `:8080`.** The server Service
  maps 80 -> pod 8080 (`kobe.nodeService`); nothing listens on Service port 8080. The pod port is
  still 8080, which `not-from-sandboxes` admits, so no policy change. Override: `web.serverUrl`
  (schema: origin only). Tilt passes the same value explicitly (`set=`).
- **Protocol:** cherry-picked `a8e45a24` (theme/colour + accent). `showName` was added to
  `siteBrandingSchema` by KOBE-499 in `27ddeb3f` (with server code); I took only
  `packages/protocol/src/branding{,.test}.ts` from it, byte-identical, so the group merge is clean.
- **Preset tokens** (`PRESET_SCHEME_TOKENS`): the five brand tokens, the shadcn neutrals (without
  `--destructive`, fixed), the seven console neutrals, plus `--ring` and `--kobe-composer-focus`
  (TH3 says the accent drives them; theme.css keeps them neutral for default). Shadows are not
  set by presets (not in this ticket's list; theme.css has one value for both schemes).
- **Custom theme CSS** also declares `--ring` and `--kobe-composer-focus` as
  `var(--kobe-brand-focus)` (TH3), beyond the plan's "only --kobe-brand/radius/font" list.
- `brandingCss` checks its own output against the plan's allow-list and returns "" (defaults)
  if it ever fails; scopes are `:root` or `#id` only (throws otherwise).
- `brandingCss({preset:"default"})` is "" and the layout then renders no `<head>`/`<style>`, so
  the default HTML only gains Next's `<link rel="icon" href="/icon.svg?…">` from `app/icon.svg`.
  Next adds the file icon only when `generateMetadata` sets no `icons`, so a configured favicon
  replaces it (checked in `next/dist/lib/metadata/resolve-metadata.js`).
- `<Brand />` without a logo renders the bare name text: markup identical to the old wordmark.
  With a logo: `<img alt="">` (+ dark `<img>` toggled by `--kobe-when-*`) and the name in a span,
  visually hidden when `showName` is false so it stays the accessible name.
- Asset URLs from the server must be same-origin paths (`/…`, not `//…`), else the whole response
  is treated as a failure (defaults).
- Only four `metadata` titles said "· Kobe" (Administration, Site console, Team console, My
  area); the fifth in the brief does not exist. "Back to Kobe" links use `<AppName />`.
- Reset-password page has no "Kobe" in its copy; unchanged.

## Open questions (for Chris or the coordinator)

- Style order: the branded `<style>` has the same specificity as theme.css and must come after
  it. React 19 emits precedence stylesheets before other `<head>` children, so it should; not yet
  confirmed in a real `next start` (the local build check was lost). Check on gate1 with KOBE-501.
- ac-4's Playwright "no frame reads Kobe" needs KOBE-499's route and KOBE-501's page; planned in
  `appearance.spec.ts` (T5). Here: an SSR unit test (`brand.test.tsx`) and layout tests.
- Preset palettes are first proposals (all pass §8 in both schemes); screenshots at the gate.

## Evidence (acceptance criteria → test or command output)

- ac-1: `presets.test.ts` (default = theme.css byte for byte), `brandingCss(default) === ""` and
  layout test (no `<head>`/`<style>`, title "Kobe", template `%s · Kobe`), `brand.test.tsx` (bare
  "Kobe" markup). Only addition to default HTML: `<link rel=icon>` for `app/icon.svg`.
- ac-2: `branding-css.test.ts` (21), `presets.test.ts` floor in both schemes for all six.
- ac-3: `branding-server.test.ts` (12); chart `tests/web-server-url.test.ts` written, needs helm
  (not installed here: ENOENT), so it runs in CI only.
- ac-4: SSR test only; Playwright part with KOBE-501.
- `@kobe/web` vitest: 301 files, 2705 tests passed. `tsc --noEmit` clean. eslint web clean
  (charts' `render.test.ts` has 4 pre-existing non-null-assertion errors, also on the base).
  Protocol 1084 passed. license:check, public hygiene, site wording ok. Prettier clean.

## Review fixes (coordinator code review)

- `getSiteBranding` is stale-while-revalidate: keeps the last validated value; after 30 s one
  background refresh, renders get the kept value at once; only a load with nothing known waits
  (≤ 1 s, then defaults, retried 30 s later). Failures never replace a good value; logged ≤ 1/min.
- Protocol `siteBrandingSchema.logo` gains optional `width`/`height`/`darkWidth`/`darkHeight`
  (positive integers ≤ 4096): **a change to the KOBE-499 contract file `branding.ts`** (additive,
  optional). `<Brand>` sets width/height scaled to 24 px when known; no `decoding="async"`.
- `lib/security/same-origin-path.ts` `isSameOriginPath()` shared by `lib/api/client.ts` and
  branding-server (rejects `//`, backslashes and whitespace).
- Hidden name uses Tailwind `sr-only`; Tiltfile override removed (chart default applies).
- Invalid `KOBE_SERVER_URL` now fails startup (throws in `instrumentation.ts`); unset still warns
  and serves defaults.
