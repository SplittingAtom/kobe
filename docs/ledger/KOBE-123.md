# KOBE-123: 47d: Pass the agent system prompt to Pi

- **Status:** in review
- **Branch / worktree:** `kobe-123-system-prompt-to-pi` in `../Kobe-wt123`
- **Depends on:** KOBE-85 (`run.start.config.system_prompt`, `SYSTEM_PROMPT_MAX_BYTES`), KOBE-82/88
  (skills via `--skill`), KOBE-71 (Pi uids), KOBE-23 (Pi RPC launch). Migrations: none.

## Decisions

- **Mechanism (read from Pi 1.0.0, not guessed):** `pi --help` lists `--system-prompt <text>` (replace)
  and `--append-system-prompt <text|file>` (repeatable). `resolvePromptInput` in Pi's resource loader
  reads the value as a file when a file of that name exists, else uses it as literal text.
- **Append, not replace.** Pi 1.0.0 builds the system message from named sections (preamble, tools,
  rules, docs, then `addendum` for the appended text, then cwd). Replacing would drop tool and
  skill guidance; append keeps both. Verified in `system-prompt.real-pi.test.ts` (real Pi + faux
  model echoing what it was given: Pi's own sections come first, the agent's text follows).
- **A file, always, never argv text.** The thread writes `<runtimeDir>/system-prompt.md` at spawn and
  adds `--append-system-prompt <path>` (args array, no shell). Keeps the prompt out of `ps` and the
  argument limit, and avoids Pi treating text that happens to be an existing path as a file.
- **Where:** the per-Pi-process runtime directory (the one that holds `model.json`): agent-owned,
  mode 0600 (agent uid) or 0640 under a Pi identity (group read only; directory not writable by Pi
  uids, only `agent/` is). Created fresh per launch, removed with the directory when Pi exits or the
  thread's Pi stops, so a prompt never carries to another thread or launch. Not the skills store:
  that is per content hash and shared across threads.
- **Tamper detection:** `verifyRuntime` (once ready and before every prompt) also checks the file is
  a regular file with exactly the written text; the tripwire's allow-list gained the name. Without
  identities (same uid) this is a detector, as for `model.json` (KOBE-71).
- **Size:** the wire schema already caps `system_prompt` at `SYSTEM_PROMPT_MAX_BYTES`; the file
  writer re-checks UTF-8 bytes and a failure fails the run `pi_unavailable` ("cannot start Pi").
- **Empty/absent prompt:** no flag. The prompt stays in the launch key, so a changed prompt restarts
  an idle Pi (as before).
- Pi's own `APPEND_SYSTEM.md`/`SYSTEM.md` discovery (agent dir, `.pi/`) is irrelevant: the agent dir
  is private and fresh, `.pi/` is ignored (`--no-approve`), and a CLI append disables discovery.

## Tests

- `pi/pi-launch.test.ts`: prompt is launch data, never in args/env; empty/absent; key changes.
- `pi/system-prompt-file.test.ts`: mode, exact text, tamper/symlink detection, `wx`, size limit.
- `agent.runs.test.ts`: argv has `--append-system-prompt <file>` (no `--system-prompt`, no text in
  argv), file content, 0600, removed after close; no flag for an empty prompt.
- `identities.real.test.ts` (CI only, needs the helper): file is agent-owned 0640 and a tool running as
  the Pi uid cannot append, move or remove it.
- `system-prompt.real-pi.test.ts`: real Pi 1.0.0 gives the model the appended prompt after its own.
- e2e (`e2e/run.sh`, gallery section; uses KOBE-89's `system?` echo): the Researcher gallery agent's
  "Web search is not available" notice must reach the model through Pi's system prompt; the Assistant's
  must not contain it.
