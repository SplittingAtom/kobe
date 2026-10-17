# KOBE-295: Consoles on Tailwind (2/3): Team console pages

- **Status:** in progress (group 7, not pushed)
- **Branch / worktree:** `group-7-consoles` in `../Kobe-g7`, on top of KOBE-294
- **Depends on:** KOBE-294 (primitives, guard), KOBE-222 (follow-ups), KOBE-301 (budget colours)
- **Followed by:** KOBE-296 (Site console and My area; `admin.module.css`)

## What moved

Every file under `app/admin/team/**` and `components/admin/team/**` uses the console primitives and
Tailwind, plus the parts the Team console shares with the Site console or My area, which therefore
move too: `overview.tsx` (both landings), `placeholder.tsx`, `gallery-score.tsx`, `policy-rules.tsx`
(Site policy floor), `usage/usage-dashboard.tsx` + `usage-chart.tsx` (Site usage),
`budgets/amount-fields.tsx` (Site budget form), `team/memory-switches-form.tsx` (Site settings),
the agent builder and skill editor (also `/me/agents`, `/me/skills`), and a new
`shared-hosting-note.tsx` (moved out of the Site egress page).

- **CSS modules removed:** `agent-builder.module.css`, `skill-editor.module.css`,
  `usage.module.css`, and the builder's own `agent-builder/field.tsx` (replaced by the console
  `Field`; schema errors go through `field-errors.ts`). `admin.module.css` lost the classes
  nothing uses any more (`soon`, `choiceList`, `cards`, `card`, `budget*`).
- **Guard tightened** (`app/console-css-guard.test.ts`): `CSS_MODULES` holds only
  `admin.module.css`; every migrated file is in `ON_TAILWIND`; new `TAILWIND_DIRS` fails on any
  CSS module imported or kept under `app/admin/team`, `components/admin/team`,
  `components/admin/usage`, `components/admin/budgets` (new files included).
- **Confirmations:** every `window.confirm` in these files is now `useConfirm()` (same question,
  split into title and description; the button names the action; focus returns to the asking
  control). Tests answer it with `answerConfirm()` (`components/admin/testing.tsx`) and check that
  nothing is sent before the answer. The Site pages still on `window.confirm` keep their stubs.
- **Publish dialog** is a Radix `Dialog` in the console root (KOBE-281 portal theming), focus starts
  on Cancel, Escape cancels; it replaced the hand-rolled focus trap.
- **Accessibility:** field errors use the console `Field` (`role="alert"`, in the description,
  `aria-invalid`); the policy tool pattern is `required`; the eval limit's error is a `FieldError`
  tied to the input; checkbox hints are their descriptions; first columns that name the row are row
  headers (budgets, usage breakdowns, break-glass history); tables keep captions (hidden where a
  heading says it). Builder and skill editor tests now expect the summary alert plus each field's.

## Deliberate visual changes, per page (for the gate1 screenshot diff)

Common to all pages (as on Invitations in KOBE-294): `PageHeader` title and muted description
instead of a browser-default h1 and hint; `Section` h2 at 1.25rem with tighter margins; console
buttons (primary for the page's main action, danger outline for remove/disable/reject/deny, `sm` in
table rows); console inputs and selects (3:1 border); table cells use the primitive padding and
border; empty lists show an `EmptyState` box instead of a sentence; warnings and errors are
`Notice` boxes with an icon (status colours, KOBE-301) instead of the `--admin-*` banners.

- **Landing:** section cards from the primitive tokens (panel background); link in medium weight.
- **Placeholder sections:** "Coming in…" is an info Notice.
- **Members:** role Save is a small button beside the select; Remove/Leave are danger buttons.
- **Team agents:** "New agent" is a primary button at the right of the header (was a link above the
  table). Inventory: Runs and Tokens right-aligned; schedules listed without bullets; Suspend is a
  danger button, Export a small secondary button. Gallery: Fork is a small button.
- **Agent builder (team and My agents):** back link above the title (PageHeader `back`); archived
  and suspended banners are warn Notices; hints sit above their control (Field order) instead of
  below; labels medium instead of bold; read-only fields keep the panel background; Save/Create is
  primary. Version history: "Current" is a green badge. Publish dialog: centred Radix dialog with an
  overlay, Cancel then a primary "Publish vN" (order swapped), warnings in a warn Notice. Eval
  status errors are error Notices with "Retry publish" as an action button.
- **Eval report:** back link above the title; definition list in two columns; numeric columns
  right-aligned; a report error is an error Notice.
- **Skills / skill editor (team and My skills):** "New skill" is a primary header button; editor as
  the builder (hints above controls, back link in the header); file cards with a bold legend and a
  danger "Remove file"; skill reach: checkbox primitive, "Add to agent…" label above its select.
- **Skill review:** filter buttons show the selected one as primary; each version is a bordered
  card; Flagged (amber), Blocklisted (red) and Not scanned (neutral) are badges; Reject is danger.
- **Schedules:** Pause/Resume small buttons. **Follow-ups (KOBE-222), Web search, Agent evaluation:**
  the explanation is the checkbox's hint (indented under its label); Save is primary.
- **Memory (and Site settings' memory section):** the fieldset is a borderless `ChoiceGroup`
  (no browser fieldset frame), each switch's text is its hint.
- **Models:** the default is an accent badge; warnings are warn Notices.
- **Budgets (KOBE-301 colours kept):** amber/red via `text-status-*` utilities, icon unchanged;
  forms in `FormRow`s with fixed-width inputs; members' table hidden when empty (only the empty
  state shows); member names are row headers; definition lists in two columns.
- **Usage (and Site usage):** tiles and chart unchanged in layout; controls labelled above selects;
  breakdown name column is a row header in normal weight; "No model calls" is an EmptyState.
- **Connectors:** each connector is a bordered card (was a wrapping flex row of heading, status and
  form); status is a badge (green when enabled); exposure radios in a `ChoiceGroup`; drifted tools
  get an amber badge; Disable is danger.
- **Egress:** domains under a "Domains" section; request Approve primary, Deny danger; header form
  as a stacked grid with labels above inputs.
- **Policy (and Site policy floor):** add-rule fields labelled above, "(required)" on the tool
  pattern; Remove is danger.
- **Retention:** upcoming deletion is a warn Notice; period radios in a `ChoiceGroup` with the
  maximum as its hint; "Cancel change" is a small button.
- **Audit view:** dates do not wrap, long JSON details wrap anywhere; empty log shows an EmptyState
  without the empty table. **Break-glass:** banners are warn Notices; "no access now" is an info
  Notice; the approval line sits under the admin's name in muted text.

## Not migrated / left for KOBE-296

- Site console and My-area pages (they still import `admin.module.css`); they render the shared
  parts above, already on Tailwind. Their `window.confirm` stubs in tests stay.

## Evidence (acceptance criteria)

- **ac-1 (met):** `console-css-guard.test.ts` (16 tests, incl. `TAILWIND_DIRS`); the three
  modules are deleted; no Team console file imports a `.module.css`.
- **ac-2 (pending gate1):** behaviour: every existing Team page test passes unchanged in what it
  asserts (confirmations now answered in the dialog; cancel paths and "nothing sent before
  confirming" added for members, suspend, restore, skill approve, models, budgets, egress
  headers, policy, retention). Screenshots: Chris to run `consoles.spec.ts` against gate1 after
  the G7 deploy and compare with the baseline; intended diffs are listed above.
- **ac-3 (partly):** web unit tests 159 files / 1561 tests green; `pnpm lint`, web typecheck,
  `pnpm format:check`, `next build` and `scripts/check-public-hygiene.sh` ok (2026-10-16). The
  gate1 Playwright run is pending the deploy. No new dependencies.
