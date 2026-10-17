# KOBE-296: Consoles on Tailwind (3/3): Site console and My area; admin CSS modules removed

- **Status:** in progress (group 7, not pushed)
- **Branch / worktree:** `group-7-consoles` in `../Kobe-g7`, on top of KOBE-294 and KOBE-295
- **Depends on:** KOBE-294 (primitives, guard), KOBE-295 (Team console, shared parts)
- **Followed by:** KOBE-291 (Site Audit log, Site Backup, Team Inventory: not built here; their
  nav entries still open the "coming soon" placeholder, unchanged)

## What moved

- **Site console** (`components/admin/site/**`, every route under `app/admin/site`): teams, users,
  invitations, roles, settings (sign-in, audit-log privacy, web search, memory), models and
  providers (catalog, limits with the KOBE-259/219 reasoning flag, gateway status), usage and the
  site budget, connectors and tool re-approval, egress ceiling, policy floor, isolation, gallery,
  skill blocklist, audit forwarding (KOBE-182), retention maximum, legal hold, break-glass and its
  reader.
- **My area:** My agents, My connector keys, My schedules and the schedule form, My memory
  (`components/memory/*`, used only by `/me/memory`; the project picker), projects (list, detail,
  settings form, members, files, conversations). My agents/skills editors moved in KOBE-295.
- **CSS modules removed:** `components/admin/admin.module.css` (the last one). With 295 that is
  all four: admin, usage, agent-builder, skill-editor. Also removed: `confirmed()` (the
  `window.confirm` helper in `parts.tsx`) and the console stylesheet's legacy rules that served
  only module pages (`--admin-fg|muted|bg|panel|border` shell variables, KOBE-283 fieldset
  spacing). The `kobe-legacy` layer stays declared, empty, so the chat's compiled layer order and
  its snapshots are unchanged.
- **Guard** (`app/console-css-guard.test.ts`): `CSS_MODULES`/`ON_TAILWIND`/`TAILWIND_DIRS` are
  replaced by one rule over `app/admin`, `app/me`, `components/admin`, `components/me`,
  `components/memory`, `components/projects`, `components/ui/console`: no file (tests included)
  imports a CSS module (default, namespace, bare, `require`, dynamic `import()`), none lives
  there, the four old modules don't exist, only the two layouts (and the builder's test pane,
  which renders the chat) import a stylesheet, every `*-page.tsx` uses the primitives, and a
  self-check proves the matcher matches. `choice-inputs-css.test.ts` now pins the choice
  primitive's inline label instead of `.form label`.

## Behaviour

- Same fields, labels, names, defaults, permissions, messages and API calls. Labels stayed
  exactly as they were (required inputs keep native `required` without the "(required)" marker,
  so no accessible name changed).
- **Confirmations:** every `window.confirm` on these pages is `useConfirm()` with its trigger:
  the same question, split into title and description; the confirm button names the action
  (`Revoke`, `Remove kimi`, `Delete schedule`, `Cap at 30 days`, …); placing/approving uses the
  primary tone, removing/denying danger. Tests answer the dialog (`answerConfirm`), check nothing
  is sent before the answer, and the shared `confirm` stub now throws, so any native confirm left
  fails. New cancel tests: deactivate user (focus back on the button), reactivate, transfer
  ownership, provider removal (in-use warning), web search removal, connector, blocklist, legal
  hold deny, break-glass deny, retention maximum, memory delete.
- **Focus after a removal** (KOBE-294 S3 pattern, now `components/admin/use-focus-after-removal.ts`):
  site invitations, providers, catalog models, connectors, custom egress domains, schedules and
  project files move focus to the next row's remove control, else the list's Section heading.
  Blocklist (list remounts) and memory delete focus the heading; a removed key focuses its
  field; a removed project member falls back to the Members heading. Tests cover connectors,
  blocklist, memory and connector keys.
- **KOBE-295 review nit:** the Site budget's request-rate field was a plain label beside console
  Fields; the whole form is on `Field` now. Label text unchanged (coordinator, 2026-10-16).
- Dark mode: only console/status tokens. Portals: the confirm dialog mounts in the console root
  (KOBE-281). Radios and checkboxes: `Radio`/`Checkbox`/`ChoiceGroup` only (KOBE-283).

## Deliberate visual changes, per page (for the gate1 screenshot diff)

Common to every page (as in 295): `PageHeader` title and muted description; `Section` h2 at
1.25rem; console buttons (primary main action, danger outline for remove/revoke/deny/disable,
`sm` in rows); console inputs, selects and textareas (3:1 border); labels above controls via
`Field` (medium weight); primitive table cells; `EmptyState` boxes instead of sentences; `Notice`
boxes with an icon instead of the `--admin-*` banners and error boxes; fieldsets borderless.

- **Teams:** "Create a team" is a Section; table below it; Rename/Members small buttons; the
  inline rename form uses small Save (primary) and Cancel; roster list indented.
- **Users:** "Deactivated" is a red badge; Deactivate is danger, Reactivate secondary.
- **Invitations (Site):** list under an "Open invitations" heading (caption hidden); Pending/Expired
  badges as on the Team page; Revoke danger.
- **Roles:** the Owner is an accent badge; Grant Admin and Transfer ownership are Sections;
  Transfer ownership is a danger button.
- **Settings:** each block is a borderless fieldset (Sign-in, Audit log privacy, Web search,
  Memory) with its legend in medium weight; the 2FA explanation is the checkbox hint; hours input
  narrow; web search provider and key side by side; Remove provider is danger.
- **Models:** gateway status is a Section; failing shows an error Notice with "Check again" inside;
  providers/catalog descriptions under their headings; model ids wrap; "Add a provider" and "Add a
  model to the catalog" are h3 Sections; checkbox explanations are hints; limits fields in a row
  with fixed width; the edit-provider Save sits after the notes; warnings are warn Notices.
- **Usage and spend:** the site budget is a Section with one field row (all `Field`s); "Usage"
  Section around the dashboard.
- **Connectors:** form fields in a row; table under "Registered connectors" (caption hidden);
  status is a badge (green Active); "N awaiting approval" is an amber badge before Review; Disable
  and Remove danger. Tool review: a Section with Close in its header, each tool a card with the
  approved/now definitions side by side (md+) in scrollable code boxes.
- **Egress ceiling:** each preset is a Section with Add all/Remove all in its header; tables
  without visible captions; Delete danger.
- **Policy floor:** "Approval defaults" Section; its explanation is the checkbox hint.
- **Isolation:** runtime check is a badge (green Verified, red Missing); the missing-runtime fix is
  a warn Notice with a numbered list.
- **Gallery:** the "Run evals in team" select labelled above; Export is a small button-styled link.
- **Skill blocklist:** hash input wide and monospace; list under "Blocked skill hashes"; Remove
  danger.
- **Audit forwarding:** Refresh in the header; status is a badge (green, amber, red); numbers
  right-aligned; last errors are error/warn Notices; "forwarding is off" is an info Notice.
- **Retention maximum:** paused and pending notices are warn Notices; "Cancel change" small.
- **Legal hold / Break-glass:** request forms as Sections, scope radios in a `ChoiceGroup`, reason
  textarea full width (max 42rem); status is a badge (amber pending, green active); request dates
  and approvals muted; Deny/Withdraw/Revoke/Approve release danger. Reader: back button above the
  title, warn note, entries as bordered cards, "Threads in scope" heading.
- **My agents:** "New agent" (primary) and "My connector keys" are header buttons (were links).
- **My connector keys:** each connector a card; Add/Replace primary, Remove key danger.
- **My schedules:** "New schedule" in the header; list under "Your schedules"; status a badge
  (green active, amber paused by an admin or deactivation); form in a card, fields in rows,
  weekdays a borderless group, the email explanation is the checkbox hint.
- **My memory:** "Memory of" picker labelled above; files under a "Files" heading as ghost
  monospace buttons; the open file is a card with its content in a panel box; history compact.
- **Projects:** "New project" in the header, the new-project form in a card; "Show archived" a
  checkbox below the header. Detail: back link above the title, conversation and memory links as
  header buttons, archived note a warn Notice, settings form fields in rows with read-only fields
  on the panel colour, Archive secondary and Delete danger; members, files and conversations as
  Sections (tables' captions hidden).

## Not migrated cleanly / open

- Nothing left on CSS modules in the consoles or My area. `components/files` (shared with the
  chat) and the chat's modules are untouched.
- A console preflight slice (KOBE-294 decision) is now possible but not done: it would restyle
  every page again; worth its own ticket if wanted.
- Section landmark names: the break-glass reader's open thread is named by its title (was
  "Thread <title>"); the project "New project" box is a region named the same as before.

## Evidence (acceptance criteria)

- **ac-1 (met):** `console-css-guard.test.ts` (15 tests); `admin.module.css` and
  `usage.module.css` deleted (with the builder and skill-editor modules from 295); no console or
  My-area file imports a `.module.css`.
- **ac-2 (pending gate1):** behaviour unchanged per the tests above (existing assertions kept,
  confirm and focus paths added). Screenshots: Chris to run `consoles.spec.ts` against gate1 after
  the G7 deploy and compare with the baseline; intended differences are listed above.
- **ac-3 (partly):** 2026-10-16: web unit tests 159 files / 1571 tests green; `pnpm lint`
  (eslint), web typecheck, prettier check, `next build` and `scripts/check-public-hygiene.sh` ok.
  Gate1 Playwright run pending the deploy. No new dependencies.
