# KOBE-497: Theming T1: branding schema and contract

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (group branch; no PR of its own)
- **Branch / worktree:** `kobe-497-branding-schema` in `../Kobe-wt497`
- **Depends on:** nothing (plan: `docs/specs/theming.md` §4.1, TH7, TH9, TH12 on `theming-plan`)

## Plan

1. `packages/protocol/src/branding.ts`: preset ids, theme/name/branding zod, limits, setting keys.
2. `site_branding_assets` (schema `packages/db/src/schema/branding.ts`, migration
   `0182_site_branding_assets`, site table in `tenancy/identity.ts` with ALL_PRIVILEGES).
3. Audit event `site.branding.updated` (+ row in `docs/audit-log.md`).

## Decisions

- Theme schema is a discriminated union on `preset`, both arms strict (no extra keys, so no CSS
  can ride along); accent `^#[0-9a-f]{6}$` only (uppercase refused: the server stores one form).
- App name: trimmed, 1-40 **code points**, no control (Cc), format (Cf) or line/paragraph separators. Defaults
  exported: `DEFAULT_APP_NAME = "Kobe"`, `DEFAULT_THEME = { preset: "default" }`.
- `PRESET_LABELS` (display names, TH9) and `BRANDING_ASSET_KINDS` exported too; the public
  `siteBrandingSchema` follows §4.2's shape `{ appName, logo: {url, dark?} | null, favicon, theme }`.
- DB backstop checks beyond the plan: sha256 is lowercase hex-64, `byte_size = octet_length(bytes)`
  and within the per-kind cap (favicon 256 KiB, logos 512 KiB), width/height null or 1..4096,
  content_type per kind (logos PNG/JPEG/WebP/SVG, favicon PNG/SVG/ICO; review fix), mirrored by `BRANDING_ASSET_CONTENT_TYPES`. `updated_by` nullable, FK to users (NO ACTION; users are never deleted).
- Audit `value`: hex sha256 or the bounded `label`; one event per setting.

## Open questions (for Chris or the coordinator)

- docs/theming.md §2 (theming-plan) mentions a "Show the name next to the logo" switch; not in T1's settings keys.
  T3/T5 may need a third `site_settings` key (e.g. `branding.show_name`).

## Evidence (acceptance criteria → test or command output)

- ac-1: `src/branding.db.test.ts`, `src/branding-upgrade.db.test.ts` (upgrade from 0181 with data);
  `catalog.db.test.ts` (RLS catalog check, grants matrix) and `probe.db.test.ts` green; full
  `@kobe/db test:db` green.
- ac-2: `packages/protocol/src/branding.test.ts` (33 tests: every preset, custom, bad
  accent/corners/font, name length incl. code points).
- ac-3: `src/audit/events.test.ts` (branding event), `src/tenancy.test.ts` (site-wide, full
  privileges, no team_id) and the generic grants-matrix test in `catalog.db.test.ts`.
