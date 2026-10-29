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
- `deriveAccent`: hover = scheme's primary at OKLCH L −0.06; link/focus searched in 0.01 L steps (max 100);
  `primaryFg` = `#ffffff` / `#111111` per scheme. `checkFloor` on a preset returns ok (presets tested in web).
- Contrast rule names: `primary_on_surface`, `fg_on_primary`, `fg_on_hover`, `link on page|panel`, `focus on page|panel|card`; 422 message names the first failure's ratio.
- SVG (coordinator 2026-10-29): `url(#id)` is allowed everywhere (styles and attributes:
  gradients, clip paths, masks, markers); any other `url(` is refused with "only url(#id)
  references are allowed".
  Also refused: `@import` and CSS escapes in style, processing instructions (xml-stylesheet),
  any entity reference beyond the five predefined, `<set|animate attributeName="href">`,
  duplicate attributes, unknown/broken XML, a root other than `<svg>`.
- Per-scheme accent (coordinator 2026-10-29, commit 0cb64167): `primary`, `primaryHover`,
  `primaryFg` are `{ light, dark }`; dark primary = accent lightened until ≥ 3:1 on dark page and
  panel. `checkFloor` checks `primary_on_surface` (3:1), `fg_on_primary`, `fg_on_hover` (4.5:1)
  in both schemes; #ffffff/#f4f4f6 refused (light), #777777 refused (fg), #2449c7 passes.
- Coordinator addition: public `logo` carries `width`/`height` and `darkWidth`/`darkHeight`
  (schema lines copied verbatim from KOBE-500's working tree). Raster: parsed pixels. SVG: root
  `width`/`height` (unitless or px), else `viewBox`; non-integer or > 4096 sides are stored as
  the aspect scaled to a 1000 px long side. ICO and unsized SVGs: none.
- Security review fixes: SVG root must be in the SVG namespace; only xlink (and reserved `xml:`)
  besides; any other xmlns, prefixed element or attribute refused (so Inkscape-namespace saves
  must be exported as plain SVG); `meta`/`iframe`/`form`/`embed`/`object`/`base`/`link`/`handler`
  elements and `content`/`action`/`src`/`formaction` attributes refused; any backslash and
  `image-set(`/`src(` refused. ICO: ICONDIR entries bounds-checked, each PNG/BMP parsed, 4096 px cap.
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
