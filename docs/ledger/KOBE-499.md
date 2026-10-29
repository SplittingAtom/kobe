# KOBE-499: Theming T3: branding API

- **Status:** in review (group branch `group-theming-1`; not pushed)
- **Branch / worktree:** `kobe-499-branding-api` in `../Kobe-wt499`
- **Depends on:** KOBE-497 (schema, contract), KOBE-498 (tokens)

## Plan

1. Shared theme maths in `packages/protocol/src/theme/` (first commit a8e45a24, cherry-picked by
   KOBE-500): `parseHex`, `toHex`, `relativeLuminance`, `contrastRatio`, `adjustLightness`
   (in-house OKLCH, chroma reduced to stay in sRGB), `DEFAULT_SURFACES`, `deriveAccent`,
   `checkFloor`.
2. `branding.show_name` key (`BRANDING_SETTING_KEYS.showName`, `DEFAULT_SHOW_NAME`,
   `SiteBranding.showName`); audit enum gains `show_name`.
3. `services/server/src/branding/`: `sniff.ts` (magic bytes, PNG/JPEG/WebP dimensions, ICO
   header), `svg.ts` (strict in-house XML reader + TH8 rules), `settings.ts` (`readAppName`,
   `readBrandingSettings`, labels), `store.ts` (10 s snapshot cache, asset rows).
4. `routes/site-branding.ts`: public GETs mounted before auth (`/v1/site/branding`, request audit
   context only); admin routes under the API (CSRF + session + `site.settings.manage`).
5. Mail: `appName` is a required input of the four message builders; callers read it with
   `readAppName(db)`.

## Decisions

- **Reset deletes the keys** (TH12): `site_settings` grant widened to ALL (adds DELETE;
  `packages/db/src/tenancy/identity.ts`). The app role could already UPDATE any key, so this
  adds no power; applied by the migration runner, no migration file.
- `deriveAccent`: hover = OKLCH L −0.06; link/focus searched in 0.01 L steps (max 100);
  `primaryFg` = `#ffffff` / `#111111`. `checkFloor` on a preset returns ok (presets tested in web).
- Contrast rule names: `primary-fg on primary`, `primary-fg on primary hover`,
  `link on page|panel`, `focus on page|panel|card`; 422 message names the first failure's ratio.
- SVG: `url(` in a `style` attribute or `<style>` is refused, even `url(#id)` (brief, TH8);
  other attributes allow only `url(#fragment)` (gradients via `fill="url(#g)"` keep working).
  Also refused: `@import` and CSS escapes in style, processing instructions (xml-stylesheet),
  any entity reference beyond the five predefined, `<set|animate attributeName="href">`,
  duplicate attributes, unknown/broken XML, a root other than `<svg>`.
- Coordinator addition: `checkFloor` adds `primary_on_surface` (accent ≥ 3:1 on the **light**
  page and panel); #ffffff and #f4f4f6 refused.
- Coordinator addition: public `logo` carries `width`/`height` and `darkWidth`/`darkHeight`
  (schema lines copied verbatim from KOBE-500's working tree). Raster: parsed pixels. SVG: root
  `width`/`height` (unitless or px), else `viewBox`; non-integer or > 4096 sides are stored as
  the aspect scaled to a 1000 px long side. ICO and unsized SVGs: none.
- A dark logo alone is not published (`logo` is null until a light logo exists).
- Asset routes: unknown kind → 404; declared part type ignored; wrong type per kind → 415
  `unsupported_type`; > 4096 px → 422 `image_too_large`; damaged header → 422 `invalid_image`;
  SVG → 422 `svg_refused`. Content-Length > cap + 16 KiB → 413 before reading; a smaller body
  whose file exceeds the cap → 413 while reading (capped buffer).
- PUT audits only settings whose value changed; DELETE audits `removed`; reset audits each
  setting it actually removed (app_name→"Kobe", show_name→"true", theme→"theme:default",
  files→"removed").
- Cache: per replica (WeakMap on the db), invalidated on this replica's writes; other replicas
  catch up within 10 s. A stale replica never sends `immutable` for a new `?v` (hash compared to
  its own snapshot).

## Open questions (for Chris or the coordinator)

- Refusing `url(#id)` inside `style` will refuse many Inkscape/Illustrator exports
  (`style="fill:url(#gradient)"`). Allowing `url(#fragment)` there as in attributes is safe
  (assets never load external resources as `<img>`); kept strict per TH8 for now.
- `primary_on_surface` is checked in light only: the accent is one value in both schemes and
  the default blue #2449c7 is 2.45:1 on the dark page, so a dark check would refuse it (the
  coordinator asked for both schemes and for #2449c7 to pass; both cannot hold). A derived dark
  primary would allow it.
- Protocol contract change (`showName`) ships inside this feature branch, as the brief asked.

## Evidence (acceptance criteria → test or command output)

- ac-1: `services/server/src/site-branding.db.test.ts` (44 tests, incl. logo sizes in the public JSON: auth/CSRF/permissions,
  validation, every format incl. WebP VP8/VP8L/VP8X and ICO, each refused SVG, 413 with an
  unread stream body, ETag/304, immutable only on matching `?v`, TH8 headers);
  `branding/sniff.test.ts`, `branding/svg.test.ts`.
- ac-2: 422 `contrast_floor` with ratio, via `checkFloor` from `@kobe/protocol`
  (`theme/accent.test.ts`: #777777 refused, #2449c7 and #15803d pass).
- ac-3: same db test: grants, reset atomicity (injected audit failure keeps everything), audit
  rows with labels/sha256.
- ac-4: `mail/mail.test.ts`, `notifications/notifications.test.ts`, and the db test (invite and
  reset mails say "Acme Data", never "Kobe").
