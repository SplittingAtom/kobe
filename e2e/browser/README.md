# Browser suite (against a deployment)

Playwright specs for the chat surfaces of v1.1 Phase A/B, run in a real browser against a running
Kobe: scroll follow, the steering panel, the context gauge, Compact now, root edit, Regenerate
with another model, Fork to a new thread, the theme toggle with its popups, the rail's
row menus with the header rename (KOBE-292), auto-titles with the rail's hover card
(KOBE-219), and pin, archive and move to project (KOBE-220; it creates a project, so the member
must be allowed to, and archives it afterwards). It is **not** part
of CI and not a pnpm workspace package: it has its own `package.json` and `package-lock.json`
(`@playwright/test` 1.55.0, Apache-2.0).

Every spec starts its own conversation, talks to the deployment's real models with short prompts
("No tools. Reply with the single word ALPHA.") and moves the threads it created to Trash at the
end. A full pass spends real tokens (Compact now sends one ~30k-token turn) and takes a few minutes
(3 min on gate1), mostly waiting for runs.

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
| `KOBE_WORKERS`  | Specs in parallel (default 1: each one starts a sandbox and spends tokens).                                               |

One spec: `npx playwright test theme` (by file name) or `-g "Compact now"` (by title). The
**Regenerate with** spec skips itself when the team has only one enabled model.

Without a local browser, run the same command in the matching image,
`mcr.microsoft.com/playwright:v1.55.0-noble`, with the three variables passed through
`docker run -e KOBE_BASE_URL -e KOBE_USER -e KOBE_PW …`.

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
