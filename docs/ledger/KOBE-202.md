# KOBE-202: A6: Per-user layout preferences (rail state, divider, artifact width)

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (feature PR); migration merged in #261 (`0093_users_ui_preferences`)
- **Branch / worktree:** `kobe-202-layout-prefs` in `../Kobe-wt202` (migration: `kobe-202-migration`)
- **Depends on:** KOBE-198 (rail), KOBE-200 (artifact tabs and resize)

## Plan

1. Migration-only PR (#261): `users.ui_preferences jsonb`, CHECK: NULL or a JSON object of at
   most 4096 bytes as jsonb text. No grant changes (`users` is Site-wide, table-level UPDATE).
2. Feature: protocol schema, `GET/PUT /v1/me/preferences`, web `lib/shell/preferences.ts`.

## Decisions

- **Store:** no per-user settings store existed (`site_settings` is Site-wide key/value; memory
  switches are per team/Site), so a nullable column on `users` (spec CE8, row "CE8 persistence").
- **Wire** (`packages/protocol/src/ui-preferences.ts`): `rail_collapsed` boolean, `threads_share`
  a number in 0..1 clamped to the rail's 0.2..0.8 (rounded to 3 places), `artifact_width` an
  integer 360..8192 px or null (the 50% default). B4's Detail toggle adds an optional key later.
- **Unknown keys are rejected** (strict object, 400), not stripped: a typo or a client ahead of
  the server fails loudly instead of being silently lost.
- **PUT merges:** it stores the keys sent and keeps the others (`coalesce(..) || $patch` in one
  UPDATE), so two devices saving different keys don't clobber each other. GET and the PUT
  response read the stored document leniently (`readUiPreferences`): keys that no longer validate
  are dropped.
- **Own row only:** both verbs use `WHERE id = <session user>`; no id is accepted anywhere (an
  `id`/`user_id` key is an unknown key, a query string is ignored). The app role can update any
  user row, so the route is the guard.
- **Size:** the body is capped at 1024 bytes (413). The column's CHECK uses
  `octet_length(value::text)` on the jsonb (jsonb adds a space after `:` and `,`); a CHECK
  violation (23514) maps to 400, never 500.
- **Debounce:** the web saver coalesces changes for 600 ms into one PUT of the changed keys;
  callers commit on release (divider, artifact resize) or toggle, never per pointer move. A run's
  transaction holds FOR SHARE on the user row, so writes stay rare.
- **Apply time** (`apply*` in `lib/shell/preferences.ts`): a share outside 0.2..0.8 or a width
  under 360 px or wider than the space right of the rail minus the conversation's 400 px floor is
  ignored, and the default applies. A value the member already changed on the page before the
  load finished is not overridden. Loading or saving failures are logged (`console.warn`) and
  never block the UI.
- **Narrow screens** (A5 KOBE-201 owns breakpoints): under the one-column breakpoint the rail
  always starts collapsed, whatever is stored, and rail toggles made there are not saved, so a
  phone's drawer never collapses the desktop rail. The divider and width still save (they only
  apply where they fit).
- **Erasure:** users are never deleted (no DELETE grant on `users`; deactivation only), and there
  is no user erase path; `ui_preferences` holds only layout numbers, no personal content, and
  lives and goes with the user row.

## Open questions (for Chris or the coordinator)

- None.

## Evidence (acceptance criteria → test or command output)

- **ac-1** cross-device: `services/server/src/me-preferences.db.test.ts` ("follows the member to
  another browser": two sign-ins, same user); web `components/shell/layout-preferences.test.tsx`
  (saved in one shell, applied on load in a fresh one).
- **ac-2** migration alone: PR #261 (catalog/grants and cross-team probe green);
  `packages/db/src/ui-preferences.db.test.ts` incl. the 4096/4097-byte boundaries.
- **ac-3** server validation and apply-time ignore: `me-preferences.db.test.ts` (400 on unknown
  keys and bounds, 413 on size, CHECK → 400, own row only); `packages/protocol/src/ui-preferences.test.ts`;
  `apps/web/lib/shell/preferences.test.ts` and `layout-preferences.test.tsx` (ignored when it no
  longer fits, narrow default kept, failures logged).
