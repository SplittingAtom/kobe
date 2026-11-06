# KOBE-541: Tree spike — can Pi summarise a branch for Kobe, and does restore keep inactive branches (CT-0)

- **Status:** in review (spike, no product code)
- **Branch / worktree:** `kobe-541-tree-spike` in `../Kobe-wt541`
- **Depends on:** none. Decides CT-7 (KOBE-548).

## Answers

- **(a) YES.** An extension command (`pi.registerCommand`) gets `ExtensionCommandContext.navigateTree(targetId,
{ summarize: true, customInstructions })`, which in RPC mode is wired to `AgentSession.navigateTree`, the same
  method the TUI's `/tree` calls. Pi collects the entries between the common ancestor and its current leaf,
  summarises them with the session's current model and appends a `branch_summary` entry under the target.
  Works only while Pi is idle (no run streaming), which is exactly the `thread.compact` shape.
- **(b) YES.** `session.restore` rebuilds the file from **every** `thread_entries` row of the thread in `seq`
  order (only the server-written skipped-actions report and `unsent-prompt` rows are left out), so all inactive
  branches come back. Real run below: 14 of 14 entries, three branches, restored and readable by Pi.

So CT-7 can be built. Its `thread.branch_summary` command only needs ids (`from_leaf_entry_id`,
`to_entry_id`, `focus`), not the branch's entries or the tree.

## (a) SDK path (Pi 1.4.0, `@earendil-works/pi-coding-agent` from `images/sandbox/pi`)

- `dist/core/extensions/types.d.ts`: `ExtensionCommandContext.navigateTree(targetId: string, options?:
{ summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string }):
Promise<{ cancelled: boolean }>`. Command handlers only ("calling them from lifecycle handlers can deadlock",
  docs/extensions.md); `ctx.sessionManager` is a `ReadonlySessionManager` (no `branchWithSummary` for extensions).
- `dist/modes/rpc/rpc-mode.js:240` binds it to `session.navigateTree(...)`; `dist/core/agent-session.js:3261`
  `navigateTree` throws while streaming or compacting, calls `collectEntriesForBranchSummary(sessionManager,
oldLeafId, targetId)` and `generateBranchSummary(entries, {...model auth, customInstructions, reserveTokens})`
  (`dist/core/compaction/branch-summarization.js`; focus becomes "Additional focus: …"), then
  `sessionManager.branchWithSummary(newLeafId, summary, details, fromHook, usage)`.
- Where the summary goes: target is a user message (or `custom_message`) → under its **parent**; any other
  entry (assistant, Kobe's `custom` `kobe.branch` marker, a summary) → under the target itself.
- Hooks: `session_before_tree` (preparation: `targetId, oldLeafId, commonAncestorId, entriesToSummarize`; may
  cancel or supply the summary) and `session_tree` after. Labels: only written when `label` is passed
  (`appendLabelChange`); Kobe passes none, so `get_tree` labels are untouched.
- Trigger from the sandbox agent: RPC `prompt` with `"/<command> <args>"`. `AgentSession.prompt` runs extension
  commands first (`_tryExecuteExtensionCommand`, before `input` handlers) and the RPC response
  `{disposition: "handled"}` is written only after the handler resolves; a throw becomes an `extension_error`
  event. `--no-prompt-templates` and the rest of `PI_LOCKDOWN_ARGS` do not disable extension commands (verified).
- Old leaf is Pi's in-memory leaf. After a restart/restore Pi's leaf is the file's last line, which need not be
  the thread's leaf: the command first calls `navigateTree(from)` without summary (moves the leaf, writes
  nothing to the file, verified), then `navigateTree(to, { summarize: true })`.

### Real run

Throwaway extension and driver (scratchpad, uncommitted): real Pi 1.4.0 `--mode rpc --session <file>` with
`PI_LOCKDOWN_ARGS` and `--extension`, a faux model registered by the same extension.

Handler (the part CT-7 would put in Kobe's extension):

```js
pi.registerCommand("kobe-branch-summary", {
  handler: async (args, ctx) => {
    const { from, to, focus } = JSON.parse(args);
    if (ctx.sessionManager.getLeafId() !== from) await ctx.navigateTree(from, {});
    await ctx.navigateTree(to, { summarize: true, customInstructions: focus });
  },
});
```

Fixture: turns A, B; Pi stopped; a `kobe.branch` marker appended under A's answer (`appendBranchMarker` shape);
Pi restarted; turn C lands on the marker. Then `/kobe-branch-summary {from: C's answer, to: B's answer}` on an
idle Pi. Before (11 lines, leaf = `95fc7058`):

```
message 654820ed parent=8d62172c user "say:A"
message cd339516 parent=654820ed assistant "ANSWER A"
message 4761c744 parent=cd339516 user "say:B"
message 57913d65 parent=4761c744 assistant "ANSWER B"
custom 8b84ec41 parent=cd339516 kobe.branch
message e8bbcf36 parent=8b84ec41 user "say:C"
message 95fc7058 parent=e8bbcf36 assistant "ANSWER C"          <- leaf
```

`session_before_tree`: `oldLeafId 95fc7058, commonAncestorId cd339516, entries [8b84ec41, e8bbcf36, 95fc7058],
customInstructions "keep the colour decision"`. After: one line appended, Pi's leaf is it; the next prompt
lands under it:

```
{"type":"branch_summary","id":"03bd22f9","parentId":"57913d65","fromId":"95fc7058",
 "summary":"The user explored a different conversation branch before returning here.\nSummary of that
 exploration:\n\nFAUX-SUMMARY of [\"C\"] | …","details":{"readFiles":[],"modifiedFiles":[]},
 "usage":{"input":282,"output":30,…},"fromHook":false,"timestamp":"…"}
message a2f0581d parent=03bd22f9 user "echo"
```

- **Entry shape:** `type "branch_summary", id, parentId (= target), timestamp, fromId (= old leaf), summary,
details {readFiles, modifiedFiles}, usage, fromHook false`. Pi prefixes the model's text with the fixed
  "The user explored a different conversation branch…" lines.
- **Enters model context on the new branch: yes.** The `echo` prompt's model saw user-role messages
  `["say:A", "say:B", "The following is a summary of a branch that this conversation came back from:
  <summary>…", "echo"]` (Pi's `branchSummary` context message, docs/message-types.md).
- Second case (restarted Pi, leaf = `69979a29` on B, `from` = C's answer, `to` = B's prompt `4761c744`, a user
  entry): the pre-move wrote nothing; summary `73e96fc8` landed under `cd339516` (the user target's parent),
  `fromId 95fc7058`.

## (b) Restore, real run against the dev Postgres (lane `wt541`)

- Code: server `sandbox-wire/delivery.ts #ensureSession` → when Pi answers `pi_rejected` for our last entry,
  `restoreParts` (`sandbox-wire/entries.ts`) pages `thread_entries … AND piSessionEntrySql ORDER BY seq` with no
  branch filter into ≤ `RESTORE_PART_MAX_BYTES` parts; sandbox `threads/manager.ts #restore` →
  `SessionRestore.writePart` (`pi/session-files.ts`) writes header + entries verbatim, **fails** (never trims)
  past `restoreMaxBytes` (default 512 MiB), renames in on `final`.
- Run: a throwaway copy of the `session restore (lost volume)` case in `sandbox-wire.db.test.ts` inserted the 14
  entries of the real session above (after both summaries) into `thread_entries`, connected a fresh
  `FakeSandbox`, called `startRun`: log "Pi session lost; restoring from Postgres", one `session.restore` part,
  and `sb.session` ids equal all 14 rows in order (test passed). The captured frame was then written with the
  real `SessionRestore` (sandbox-agent `dist`) and real Pi opened it. `get_tree` on the restored file:

```
… message:cd339516 (A's answer)
    message:4761c744 → message:57913d65 → branch_summary:03bd22f9 → message:a2f0581d → message:69979a29
    custom:8b84ec41(kobe.branch) → message:e8bbcf36 → message:95fc7058
    branch_summary:73e96fc8                                          <- leafId (last row by seq)
```

and `/kobe-branch-summary {from: 73e96fc8, to: 69979a29}` on it appended `6726aa82` under `69979a29`.

- The restored file contains: every Pi-written entry of every branch (messages, `kobe.branch` markers,
  `branch_summary`, model/thinking changes, the system message), not the skipped-actions report or unsent
  prompts, with a default header (cwd = workspace).

## Notes for CT-7 (not blockers)

1. **Member prompts reach Pi verbatim** (`threads/manager.ts` `type: "prompt"`), and Pi runs an extension command
   for any prompt starting with `/<name>`: once Kobe's extension registers `kobe-branch-summary`, a member typing
   `/kobe-branch-summary {…}` would run it. CT-7 must gate the command (e.g. a one-time nonce the agent puts in the
   extension's root-owned state file, refused otherwise) or the agent must neutralise a leading `/<registered
command>` in member prompts.
2. **Model and token:** the summary uses Pi's current model; extension commands skip `input` handlers, so
   kobe-models must refresh the run token on `session_before_tree` as it does on `session_before_compact`
   (register.ts:179), and the agent selects the run's model first, as `threads/compact.ts` does.
3. Pi's leaf after a restart or restore is the last row by `seq`, not `threads.leaf_entry_id`: always send
   `from_leaf_entry_id` and pre-move (shown above).
4. Summary placement for a user-message target is its parent; the server should pass the node Kobe means
   (normally the assistant answer or a `kobe.branch` marker) and read the entry's `parentId` back.
5. `nothing_to_summarize`: with no entries to summarise Pi appends nothing and only moves its in-memory leaf
   (`branch`), so the command must check `entriesToSummarize` (on `session_before_tree`) and cancel/refuse.

## Evidence (acceptance criteria)

- ac-1: (a) above — SDK path with signatures from the installed 1.4.0 `dist`, before/after session excerpt.
- ac-2: (b) above — real `session.restore` via the server against the dev Postgres, then real Pi on the file.
- ac-3: no product code or migration in the diff (this ledger only); both answers yes, so no RUN-LEDGER
  Open problems line is required (notes 1–2 belong in CT-7's brief).
