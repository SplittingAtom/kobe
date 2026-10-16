# KOBE-283: Admin Connectors page: radios and checkboxes float centred above their labels

- **Status:** committed on `group-1-fixes` (ticket group G1; no PR of its own)
- **Branch / worktree:** `group-1-fixes` in `../Kobe-g1`
- **Depends on:** none (KOBE-282's theme tokens are unrelated to the cause)

## Root cause

`apps/web/components/admin/admin.module.css` had `.form label { display: flex; flex-direction:
column }` (since KOBE-20). It is a descendant selector, so it matched every label anywhere inside a
`.form`, not only the field captions it was meant for. A choice label (`<label><input
type="radio"/> text</label>`) became a column: the box on its own row, stretched to the row's width
(`align-items: stretch`), and Chrome draws a stretched checkbox/radio centred in its box. Measured on
gate1 (main): the "Read-only tools" radio was 936 px wide, each tool checkbox 929 px. In the tool
`<ul>` the block-level flex label pushed the list marker onto a line of its own (the stray bullets).
The team connectors card is `<article className={styles.form}>`, so all its radios and checkboxes
were hit. Not a KOBE-282 regression: both themes show it because the layout rule is theme-free.

## Fix (at the rule, not the page)

- `.form label:not(:has(input:is([type="checkbox"], [type="radio"])))`: field captions still stack;
  choice labels keep the browser's inline flow (box, then text) in every console form.
- Same exclusion on the identical `.controls label` rule in `admin/usage/usage.module.css`.
- `agent-builder.module.css`: `.field input` (width 100%) now skips checkboxes and radios.
- `.shell fieldset label:has(choice)`: 1rem apart when choices sit side by side.
- `.choiceList` (no bullets, no indent) on the connector's Tools list.

## Pages checked (every console file with `type="radio"` / `type="checkbox"`)

Affected before the fix (choice label inside a `.form`):

| Page                                    | File                                         | Inputs                                                                 |
| --------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------- |
| /admin/team/connectors (reported)       | `team/connectors-page.tsx`                   | exposure radios, tool checkboxes                                       |
| /admin/site/break-glass                 | `site/break-glass-page.tsx`                  | scope radios, checkbox                                                 |
| /admin/site/legal-hold                  | `site/legal-hold-page.tsx`                   | scope radios                                                           |
| /admin/site/models (catalog edit/add)   | `site/model-catalog.tsx`, `model-limits.tsx` | images and limits checkboxes                                           |
| /admin/site/models (providers edit/add) | `site/model-providers.tsx`                   | key/private-network checkboxes (had a `<span>` workaround; still fine) |
| /me/schedules (schedule form)           | `me/schedule-form.tsx`                       | weekday checkboxes, enabled                                            |

Not affected (no `.form` around the choice, or table cells), checked for other rules: team
web search, eval settings, models (table), retention, egress (table), skill review, memory
switches, agent builder frontmatter (own `.checkbox` class; `.field input` fixed anyway), site
policy floor, web search, settings, retention, egress ceiling (table). Site connectors
(`site/connectors-page.tsx`, `connector-tool-review.tsx`) and /me/connectors
(`me/my-connectors-page.tsx`) have no radios or checkboxes: only text/url/password fields and a
select, whose stacked captions are unchanged.

## Evidence

- Guard test `apps/web/components/admin/choice-inputs-css.test.ts` (happy-dom has no cascade, so it
  pins the CSS contract like `theme-css.test.ts`): over every stylesheet in `components/admin`,
  `components/me` and `app`, a rule that makes labels block/flex/grid/column must exclude choice
  labels, a rule that makes inputs full width or block must skip checkboxes and radios, and the
  Tools list carries `.choiceList` with `list-style: none`. Red on the old CSS (3 failures:
  `.form label`, `.controls label`, `.field input`, missing class), green after.
- gate1 (main, read-only, light and dark): a throwaway Playwright spec opened
  /admin/team/connectors, ticked "Chosen tools" locally (never saved), measured, then injected the
  fixed rules (CSP bypassed for the spec only). Before: radios 936 px wide on their own rows, label
  `display: flex; column`, tool items `list-style: disc`. After: 13 px boxes, text starts 16 px to
  the right on the same line, the three radios on one row, tool items without markers.
- The fix itself can only be checked visually on gate1 once G1 is deployed.
- `pnpm verify` green before the commit.
