# Gate — Site theming and branding (KOBE-497..503)

Ticket: KOBE-508. Plan: [`docs/specs/theming.md`](../specs/theming.md); catalogue:
[`docs/theming.md`](../theming.md). **Approved by Chris on 2026-10-29** ("gate review looks good"):
TH3 stands (the chat's send button stays neutral), the six preset names are confirmed, KOBE-504 and
KOBE-505 stay optional in the backlog.

## What shipped

| PR   | Tickets            | Main      | Content                                                                  |
| ---- | ------------------ | --------- | ------------------------------------------------------------------------ |
| #400 | KOBE-497, KOBE-498 | 96780b1f  | `site_branding_assets` + protocol contract; design tokens + guard test   |
| #401 | KOBE-499, KOBE-500 | c93407de  | branding API, uploads, SVG rules, mail name; themed first paint, presets |
| #402 | KOBE-501, 502, 503 | 5cd8a91e  | Appearance page; docs; chart-seeded defaults                             |
| #403 | follow-up          | 87398452  | default sans token = Tailwind's stack; Appearance e2e helper             |
| #404 | follow-up          | (pending) | Appearance e2e picks file inputs by exact label                          |
| #405 | follow-up          | (pending) | server reads branding fresh on every request (stale per-replica cache)   |

Deployed to kobe-gate1 as `local-5cd8a91ea59b` on 2026-10-29, then `local-87398452b50d` (#403); the
#405 fix follows as `local-<sha>` once merged.

## Evidence

- **ac-1 (no visual change with nothing configured):** console screenshot comparison
  (`e2e/browser/tests/consoles.spec.ts`, 127 shots: light, dark, phone width) against the baseline
  taken at `local-876e9cf90597`. First run at `local-5cd8a91ea59b`: every text page differed because
  the sans token resolved to a different face in the Linux container (Tailwind's `-apple-system …
Arial` stack → Liberation Sans before; `system-ui` → WenQuanYi after). Fixed in #403 by keeping
  Tailwind's stack as the default token. Second run at `local-87398452b50d`: the console content of every page is identical; the only
  differing pixels are the chat chrome behind the panel (bar, rail, panel title: 1916 px, ratio 0.01 per
  page), whose font moved to the shared stack with the chat (accepted). Baseline re-taken at
  `local-87398452b50d` with default branding (129 shots, compute2 `~/kobe-e2e-browser/browser/console-shots`).
- **ac-2 (first paint branded):** `appearance.spec.ts` on gate1: name, logo and favicon steps pass; the script-SVG refusal step
  failed because, with two server replicas, `GET /v1/site/branding` right after an upload answered
  from the other replica's 10 s cache, so the reload showed no logo and the dark-logo picker stayed
  disabled. Fixed in #405 (no per-replica cache). Re-run after the #405 deploy is recorded in the KOBE-508 log. (Steps: name in the server-rendered
  `<title>` and `<h1>` of a fresh load; logo `<img>`; favicon `<link rel=icon>`; Plum preset AA in
  both schemes; script SVG refused; reset).
- **ac-3 (contrast floor):** server route tests (422 `contrast_floor`); page: Save disabled with the
  ratio; spec covers a refused accent.
- **ac-4 (SVG rules, headers):** server tests (namespaces, script/on*/foreignObject/external href,
  `url(#id)` allowed, CSS escapes, `image-set(`); assets served `nosniff` + sandboxing CSP, immutable
  only on a matching `?v=`.
- **ac-5 (audit):** `site.branding.updated` per setting with label or sha256 (server tests; row in
  `docs/audit-log.md`).
- **ac-6:** `theme.spec.ts` on gate1 at `local-87398452b50d`: 2 passed (default preset; the
  Appearance spec covers the Plum preset's AA checks); `pnpm license:gate`: passes on main
  5cd8a91e (nothing pending).
- **ac-7 (backup/restore):** not run on gate1 in this cycle (recorded as such on KOBE-508); the assets table and settings keys are in
  the `public` schema dump; `startup-seeds.ts` registration verified by `restore-target.db.test.ts`.
- **Reviews:** Opus DB/security passes on 497 (3 LOW fixed), 499 (2 MEDIUM + 3 LOW fixed), 503
  (1 MEDIUM + 3 LOW fixed); `/code-review medium` on 498 (10), 500 (7), 501 (8), all addressed.

## Decisions taken at the gate (Chris, 2026-10-29)

1. TH3 confirmed: the chat's send button stays neutral while console primary buttons, links, focus rings,
   badges and count pills take the accent. Reverse with one line (`--primary` → brand) if the mix
   reads wrong.
2. Preset names confirmed: Default, Slate, Forest, Plum, Ember, Tokyo Nights.
3. KOBE-504 (allow-listed token overrides, export/import) and KOBE-505 (one neutral palette) stay optional.
4. Rollback tag `local-5cd8a91ea59b` is removed from the nodes after the #405 build is deployed.

## How to review on gate1

Sign in as the owner on the gate1 site (address and credentials in CLAUDE.local.md) → Site console → System → Appearance.
Rename the site, upload a logo (SVG from Inkscape: save as Plain SVG) and a favicon, try each preset
in light and dark, set a custom accent (watch the contrast line; `#777777` is refused), then Reset to
defaults. Other web replicas pick a change up within 30 s.

## Flakes seen (not theming)

KOBE-506 (file-viewer rename test), KOBE-507 (db-core 57P01 unhandled error), one executor e2e
shard cascade (sandbox stuck after the cold-start trials; rerun green).
