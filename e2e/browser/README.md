# Browser suite (against a deployment)

Playwright specs for the chat surfaces of v1.1 Phase A/B, run in a real browser against a running
Kobe: scroll follow, the steering panel, the context gauge, Compact now, root edit, Regenerate
with another model, Fork to a new thread, the theme toggle with its popups, the rail's
row menus with the header rename (KOBE-292), auto-titles with the rail's hover card
(KOBE-219), pin, archive and move to project (KOBE-220; it creates a project, so the member
must be allowed to, and archives it afterwards), and sharing with the team between two members
(KOBE-221; needs `KOBE_USER2`, skipped without it), and follow-up chips behind the team switch
(KOBE-222; `KOBE_USER` must be a team admin; it turns the switch on and off again), and `@file`
mentions (KOBE-223; it drops a small file into the member's `uploads/` and deletes it at the
end), and thumbs up and down on an answer with a reason and a comment (KOBE-275). It runs in CI only as Gate 5
(below) and is not a pnpm workspace package: it has its own `package.json` and `package-lock.json`
(`@playwright/test` 1.55.0, Apache-2.0).

Every spec starts its own conversation, talks to the deployment's real models with short prompts
("No tools. Reply with the single word ALPHA.") and moves the threads it created to Trash at the
end. A full pass spends real tokens (Compact now sends one ~30k-token turn) and takes a few minutes
(3 min on gate1), mostly waiting for runs.

## Gate 5 (KOBE-227)

`e2e/gate5.sh` runs these specs, grouped by user story U17–U24, plus `tests/gate5/` for the
criteria they leave out, and gives one verdict per story (docs/gates/gate-5.md). In CI (shards
`gate5-a`, `gate5-b`) it runs them against k3d with the scripted fake model: `KOBE_FAKE_MODEL=1`
makes the specs use its prompts (`tests/support/gate5.ts`), and `KOBE_BROWSER_MAP=host:port` makes
Chromium reach the site's host through a port-forward. `KOBE_BROWSER_RESULTS` moves the JSON report.

## Run it

```bash
cd e2e/browser
npm ci
npx playwright install chromium   # once, unless you use the Playwright container below
KOBE_BASE_URL=https://kobe.example.org KOBE_USER=member@example.org KOBE_PW='…' npx playwright test
```

| Variable        | Meaning                                                                                                                   |
| --------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `KOBE_BASE_URL` | The deployment's URL (required).                                                                                          |
| `KOBE_USER`     | A member who can sign in with a password, can run conversations and (for the theme spec) can open the team admin console. |
| `KOBE_PW`       | That member's password. Pass it from a secret store; never write it to a file or a log.                                   |
| `KOBE_USER2`    | A second member of the same team (password sign-in, only that team), for the sharing spec; optional.                      |
| `KOBE_PW2`      | That member's password; same rules as `KOBE_PW`.                                                                          |
| `KOBE_WORKERS`  | Specs in parallel (default 1: each one starts a sandbox and spends tokens).                                               |

One spec: `npx playwright test theme` (by file name) or `-g "Compact now"` (by title). The
**Regenerate with** spec skips itself when the team has only one enabled model.

Without a local browser, run the same command in the matching image,
`mcr.microsoft.com/playwright:v1.55.0-noble`, with the three variables passed through
`docker run -e KOBE_BASE_URL -e KOBE_USER -e KOBE_PW …`.

## Files tree (KOBE-304)

`files-tree.spec.ts` uploads three small files into a new folder of the member's workspace, opens
it in the rail's Files tree with the keyboard, checks the ARIA tree, the type icons and the 26 px
rows, saves screenshots of the tree in light and dark (`test-results/.../files-tree-*.png`),
renames a file with F2, moves it by drag and drop and with Move to…, checks that a name clash is
refused, and deletes the folder at the end. No tokens: `npx playwright test files-tree`.

## Resizable rail (KOBE-305)

`rail-resize.spec.ts` drags the handle on the rail's right edge to 400 px, checks the width is
saved per user (a second browser context gets it) and survives a reload, Home/End (200 and 560 px at 1280), Mod+B collapse and expand (the width comes
back), double-click back to 280 px, no handle at 960 and 390 px, and, with a file tab open in the
artifact column, that End stops at 520 px so the conversation keeps 400 px and the column 360 px.
Screenshots in light and dark (`test-results/.../rail-resize-*.png`). It uploads one small file
and deletes it at the end, and puts the member's stored rail width back as it found it; no
tokens: `npx playwright test rail-resize`.

## Remembered approvals (KOBE-289)

`remember-approvals.spec.ts` makes the agent write and share a small file, remembers the
share_file approval for "this conversation", checks the next share runs without a card and its
tool card says "Allowed by your rule (this conversation)", finds the rule on My area, Approvals and
on the team Policy page, revokes it there and checks the next share asks again (denied). It
revokes the signed-in member's share_file rules at the start (any scope: one made by hand would
skip the first card) and any it left at the end. `KOBE_USER` must be a team admin, with the team's
remember limits allowing "this conversation"; a few short model turns:
`npx playwright test remember-approvals`.

## Console sections (KOBE-291)

`console-sections.spec.ts` opens the Site audit log (Verify chain, a category filter and Clear),
Site backup and restore, and the Team inventory, and checks none of them is a "coming soon"
placeholder. Read-only, no tokens. `KOBE_USER` must be a site Admin or the Owner and a team admin
of the active team: `npx playwright test console-sections`.

## Thinking level (KOBE-260)

`thinking.spec.ts` looks in the model picker for an enabled model that offers a thinking level
(Site → Models: a reasoning model with a thinking control and thinking allowed; the team must not
have turned it off), picks **Thinking off**, asks for one word and checks that the answer has no
reasoning block and that the thread and its run record `off`. It skips itself when no model
offers a level. On kobe-gate1, give glm-5.3 the `reasoning_effort` control first.

## Console screenshots (KOBE-294)

`consoles.spec.ts` screenshots every Site console, Team console and My-area page in light and dark
(full page, times masked) for the move of the consoles to Tailwind. It spends no tokens and changes
nothing. `KOBE_USER` must be the site Owner and a team admin of the active team; the pages come
from the consoles' navigation, and detail pages (an agent, a skill, a project) from the first item
of their lists.

```bash
npx playwright test consoles --update-snapshots=all   # baseline, before a page's styling changes
npx playwright test consoles                          # compare later; diffs in test-results/
```

Baselines land in `console-shots/<platform>/<theme|mobile>/<page>.png` (gitignored: they show
deployment data); take and compare them on the same platform (the Playwright container, or the
Mac). Besides light and dark at 1280 px, a phone-width pass (390 px) covers the folded nav, a
table and a form. A page that fails to load is reported at the end without stopping the rest.

## What you get

- `test-results/`: per-test traces and screenshots of failures, and `results.json`.
- `playwright-report/`: the HTML report (`npx playwright show-report`).
- `.auth/user.json`: the signed-in session the `setup` project saves for the specs. It holds a
  session cookie: it is gitignored; delete it after a run on a shared machine.

## Writing specs

- Select by role and accessible name, labels and `data-kobe-*` attributes (`data-kobe-steering`,
  `data-kobe-scroll`, `data-kobe-follow`, `data-kobe-marker`), never by CSS class.
- Use the `chat` fixture from `tests/support/chat.ts`: `open()` starts a new conversation,
  `ask()` sends and waits for the run to finish, and every thread it saw goes to Trash afterwards.
- Keep prompts short and tool-free; allow generous timeouts for runs (`RUN_TIMEOUT_MS`).
- Compaction needs a short turn **before** a turn over Pi's 20k-token "keep recent" budget;
  otherwise the server answers `nothing_to_compact` (see `compact-now.spec.ts`).
