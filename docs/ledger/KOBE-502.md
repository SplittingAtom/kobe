# KOBE-502: Theming T6: docs

- **Status:** in review (branch `kobe-502-theming-docs` on `group-theming-3`; not pushed)
- **Worktree:** `../Kobe-wt502`. Docs only; no code changed.

## Done

- `docs/theming.md`: marked shipped (KOBE-497..503); token tables checked against `theme.css`
  (added `--kobe-ctx-pattern-*`, `--kobe-composer-focus`, real `--admin-hover`; shadows, mono stack
  and wordmark are fixed: no preset sets them, one shadow value for both schemes); six presets with
  names and looks; per-scheme derived accent and `checkFloor` rules as coded; SVG rules from
  `svg.ts`; new §12 Appearance page + API, §13 settings and chart defaults. Section numbers kept
  (code comments cite §4.1, §5, §6, §8).
- `docs/specs/theming.md`: "Shipped" section (PRs, implementation decisions).
- `docs/install.md`: one "Branding and theming" section (Appearance, `web.serverUrl`, chart
  defaults, SVG hint) replacing KOBE-503's "Branding defaults".
- `docs/backup-restore.md`: branding tables in the dump; restore step 7 smoke check.
- NOTES.txt, README sentence, `docs/audit-log.md` row (show_name, labels, `removed`, system seed).

## Code that contradicts the docs (not changed)

- Appearance reset dialog says "Every page shows Kobe's own look again" / "Reset to Kobe's
  defaults", but with chart `branding.*` values the reset returns to those.
- `values.yaml` comment says "Reset to defaults"; the button reads "Reset to Kobe defaults".
- Ledger KOBE-503 and commit 2779e3b5 say the reset seeds in its own transaction; the code
  (`site-branding.ts`) seeds inside the reset's transaction.

## Evidence

- ac-1: token cross-check script (every `--kobe-*`/`--admin-*` in the catalogue exists in
  theme.css, except the layout variables, now attributed to `shell.module.css`).
- ac-2: install/backup docs updated; the gate1 `kobe backup` + `kobe restore` run is for the gate.
- `pnpm format:check`, `scripts/check-public-hygiene.sh`, `scripts/check-site-wording.mjs` pass.
