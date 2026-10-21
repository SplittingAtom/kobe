# Kobe — Context Viewer (KOBE-470 server, sandbox and protocol)

Status: **decisions by Chris, 2026-10-21** (CV1–CV2 binding; CV3–CV9 settled in KOBE-470 within
them). Contracts: `packages/protocol/src/context-viewer.ts` (route) and
`packages/protocol/src/sandbox-wire/context-frames.ts` (wire). Ledger: `docs/ledger/KOBE-470.md`.

## 1. Summary

The context gauge opens a viewer that shows what the thread's **latest model call** sent the
model, as ordered sections (system prompt, agent instructions, skills, memory, viewed file, tool
definitions, messages, tool calls and results, compaction summary), each with its text and token
count, plus the model's context window. It is read live from the owner's sandbox when the viewer
opens (and on Refresh) and is never stored.

## 2. Decisions

**CV1. The latest model call, live, nothing stored.** (Chris) The viewer shows the context as of
the thread's latest model call: what the model saw, not a reconstruction of what it would see
next. It is fetched from the sandbox on open and on Refresh. A hibernated sandbox is woken, with
progress, like sending. Nothing is stored: no copy in Postgres beyond the wire's transient command
row (CV8), no content in logs, no audit entry (the route audits nothing at all).

**CV2. Thread owner only.** (Chris) Only the owner sees the context. A teammate or project member
the thread is shared with gets 403 `not_owner`; anyone else the usual 404 `thread_not_found`. The
context can hold the owner's memory, viewed files and tool output, which sharing never exposed.

**CV3. Section kinds.** `system_prompt`, `agent_instructions`, `skills`, `memory`, `viewing_file`,
`tool_definitions`, `user_message`, `assistant_message`, `tool_call`, `tool_result`,
`compaction_summary`, `other`, in the order the model saw them. Where each comes from (Pi 1.0.0):

| Kind                 | Source                                                                                                                                                                                       |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `system_prompt`      | Pi's prompt sections `preamble`, `tools` (tool guidance), `rules`, `docs`, `cwd` (`core/system-prompt.js`); a later system message's text ("Prompt update")                                  |
| `agent_instructions` | Pi section `addendum`: Kobe's `--append-system-prompt` file (agent/system prompt, KOBE-123); `project_context` (context files); the project instructions block kobe-tools appends (KOBE-245) |
| `skills`             | Pi section `skills` (the skills index)                                                                                                                                                       |
| `memory`             | The fenced memory index kobe-tools appends for the run (KOBE-157)                                                                                                                            |
| `viewing_file`       | The fenced viewed file kobe-tools appends for the run (KOBE-462)                                                                                                                             |
| `tool_definitions`   | One per tool the call declared (`toolsAdded` of the system messages, or the context's `tools`): name, description, JSON schema                                                               |
| `user_message`       | User messages (images as `[image <type>]`, counted as Pi's 1200-token image estimate)                                                                                                        |
| `assistant_message`  | An earlier answer's text, or its thinking (label "Thinking")                                                                                                                                 |
| `tool_call`          | One per tool call of an earlier answer: label = tool name, text = arguments as JSON                                                                                                          |
| `tool_result`        | Tool results (label = tool name, "(error)" when it failed)                                                                                                                                   |
| `compaction_summary` | The user message Pi builds from a compaction (`The conversation history before this point was compacted…`)                                                                                   |
| `other`              | Branch summaries, custom messages (label = custom type), removed prompt sections or tools, the "N sections not shown" placeholder (CV6)                                                      |

When kobe-tools adds memory, project instructions or the viewed file, Pi sends the whole prompt as
one forced text; the agent splits it back exactly by the parts it wrote for the run, or by their
headers when they changed since, and splits Pi's part by its `<name>…</name>` sections.

**CV4. Where the sections come from (exactness).** Three sources, named in `source`:

- `model_call` (exact): kobe-models, the Pi provider every model call goes through, records the
  context Pi handed it (the leading system message with prompt sections and tool declarations, and
  the conversation, after Pi's own conversions) together with the answer's usage, in
  `kobe-context.json` in the Pi process's private `agent/` dir (env `KOBE_CONTEXT_FILE`; atomic
  replace after every call; mode 0640 so the agent, in Pi's group, reads it and the tool
  executor's partner uid cannot). Summaries (compaction, branch summary: `cacheRetention: "none"`) are skipped. Image
  data is never recorded. The file goes with the Pi process (its runtime dir is removed on exit).
- `session`: no call was recorded since the thread's Pi started (after a wake, an idle reap or a
  relaunch for a new config). The agent rebuilds the latest call from the thread's Pi session
  file: the path from the leaf, the context before the last answer, with the latest compaction
  before it applied (Pi's `buildSessionContext`). Exact for the conversation and for the prompt
  sections and tools Pi recorded; without the per-run memory, project instructions and viewed
  file (never in the session), and without `context_edit` entries (Kobe writes none).
- `none`: the thread has no model call yet.

**CV5. Token counts.** No tokenizer runs in the sandbox. Each section is estimated as Pi estimates
(characters / 4, an image 1200), then scaled with the largest-remainder method so the sections
add up exactly to the call's reported prompt tokens, input + cache read + cache write: the number
the context gauge shows for that call (`messageContextTokens`, `latest_call`). `tokens_basis`:
`usage` when scaled, `estimate` when the call reported nothing (failed early) or there was no
call. `context_window` is the window kobe-models gave Pi for that call (the catalog limit, or the
site default, KOBE-259); null for `session` and `none` (the web uses the gauge's window). A
compaction after the latest call is not reflected (the gauge shows "unknown" then; the viewer
still shows the call).

**CV6. Size caps.** Section text is at most 128 Ki UTF-16 units; a longer one is cut and ends with
`[… N more characters not shown]` (`truncated`, `chars` = the whole length, `tokens` = the whole
section). All texts together are at most 3 MiB UTF-8 (the agent lowers the per-section cut until
they fit, and the whole `command.result` frame stays under the 4 MiB wire cap). Past 4000 sections
the middle of the conversation is left out (`omitted_sections`) behind one `other` placeholder that
carries their tokens, so the prompt and the newest messages stay. `truncated` says any of this
happened. The capture itself is capped at 32 MiB (a larger call falls back to `session`).

**CV7. Route.** `GET /v1/threads/{id}/context` (`team.chat`, owner only, 30 reads a minute per
member):

- **200** `ThreadContext` (`ThreadContextResult` + `thread_id`), `cache-control: private, no-store`.
- **202** `{status: "waking", retry_after_ms: 2000}`: the member's sandbox was not connected; a
  wake was started (as on send). The web shows "Waking your workspace…" and asks again.
- **403** `not_owner`, **404** `thread_not_found`, **409** `thread_busy` (the session is being
  compacted or restored) or `context_unsupported` (an agent older than the capability), **429**
  `rate_limited`, **502** `context_unavailable` (the sandbox failed, or its answer did not
  validate), **503** `sandbox_unavailable` (timeout, wake failure, connection lost). One fixed
  message per code; the sandbox's text is logged by code only, never relayed.

**CV8. Wire command `thread.context`.** Server → the member's own sandbox only (never a skill
eval's), behind hello capability `thread_context`, `{command_id, thread_id, max_bytes}`, deadline
120 s. Before delivering it the server brings the thread's session in line (entry sync, or a
session restore after a wake), as for a run start. The agent answers `command.result` with a
`ThreadContextResult`, which the server validates again. Like every command result it passes
through the `sandbox_commands` row (any replica may hold the socket): the row is deleted when the
requesting replica reads it, or by the expiry sweep. That transient row is the only place the
content touches Postgres. The command starts no Pi and writes nothing in the sandbox.

**CV9. Text is untrusted.** Every section text came from the model, tools, web pages, files or
teammates. The web renders it as plain text only (never Markdown or HTML). Without Pi identities
(development) the thread's own tools could rewrite the capture or the session file; the viewer
shows what the files hold; so can they when the tools run as Pi's own uid (no tool executor). With
the executor (KOBE-167) the capture is out of the tools' reach; the session file is on the
workspace volume, which the tools can write (as for every session).

## 3. Known gaps

- `session` source: no memory, project instructions or viewed file; no context window.
- Later system messages are shown as their sections; providers render them as "Updated system
  prompt section" text (wording differs, tokens are scaled anyway).
- Per-section tokens are estimates scaled to the reported total; only the total is exact.
- The OpenAPI document does not list the route yet.
