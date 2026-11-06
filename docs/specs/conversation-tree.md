# Kobe — Conversation tree

Status: **decisions by Chris, 2026-11-05** (Q1–Q31 in §8; CT1–CT20 below reflect them). Hadron
spec `e8b1281a-db5c-41c0-9e9f-a0417409fcff`; tickets filed 2026-11-06: CT-0 KOBE-541, CT-1
KOBE-542, CT-2 KOBE-543, CT-3 KOBE-544, CT-4 KOBE-545, CT-5 KOBE-546, CT-6 KOBE-547, CT-7
KOBE-548, CT-8 KOBE-549 (lane brief: `docs/ledger/conversation-tree-lane.md`). Written against
main `518ebe26`. Companion to `docs/specs/thread-lineage-and-folders.md` (forks between threads);
this spec is about the branches **inside** one thread.

Request (Chris, 2026-11-05): Pi's `/tree` lets a user branch a conversation at any point and see
the whole tree with its branches. Support that in Kobe, and show it.

## 1. Summary

Kobe already keeps every thread as Pi's entry tree (D15) and already branches in place: Edit,
Regenerate, Regenerate with another model and Retry each start a sibling under the edited prompt's
parent, and the conversation shows "Version n of N" arrows at the branch point. What a member
cannot do today is **see the tree**, **look at another branch without moving the thread**,
**continue from an arbitrary answer**, **name** a point in the tree, or **carry a summary** of the
branch they leave. This spec adds:

- a **local head**: the conversation on screen can show any branch without moving the thread's
  leaf, for owner and reader alike; the leaf moves only on "Make it current" or a send (CT3);
- a **Conversation tree** view of the open thread, one row per turn as Pi draws it, every branch
  visible, the path on screen highlighted, the leaf marked, badges for what a branch left behind
  (files, memories, approval rules); clicking a node shows that branch (CT4–CT6);
- **Continue from here** on any answer: the next prompt branches under it (CT8);
- **labels** on any node, kept by Kobe, never seen by the model (CT9);
- **Compare versions**: two answers to the same prompt side by side (CT10);
- **carry a summary** when making another branch current: Pi summarises the branch being left and
  the summary enters the new branch's context (CT11; a spike decides whether it ships in this lane);
- a junction count on the hover card and a tree button in the conversation header (CT12), the
  leaf on the thread-updated event (CT13), every branch in export (CT14), search hits that open
  on their branch (CT15).

The tree's job is **returning to an earlier version** (Q1): switching is the first action
everywhere; compare and the badges are secondary. No new run-stream event kinds beyond one field,
no change to how runs branch (`parent_entry_id` on the message submit), no change to forks or to
the lineage strip. One small team table (labels), one read, one write, one event field, one rate
limit, and, if the spike says yes, one run kind beside `compaction`.

## 2. Where this sits among the Kobe decisions

| Decision                    | How this spec relates to it                                                                                                                                                                                                         |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **D13** Pi behind the agent | Unchanged. Pi's `fork`, `get_tree` and tree navigation stay unbridged; branching keeps using the `kobe.branch` marker and `parent_entry_id`. CT11 adds one extension-driven command, like compaction.                               |
| **D15** Record              | Unchanged for entries: the tree is drawn from `thread_entries` as mirrored. Labels are Kobe's, in their own team table, never Pi session entries (CT9). A branch summary is a Pi entry (`branch_summary`), mirrored like any other. |
| **D16** Wire                | `thread.updated` gains `leaf_entry_id` (additive). One read (`branches`), one write (`label`), the hover card gains a field, the run kind enum gains `branch_summary`.                                                              |
| **CE15** Compact now        | CT11 follows it exactly: a run kind, created under the thread lock, delivered to the sandbox agent, Pi writes the entry, Kobe mirrors it. Pi owns the summary; Kobe never summarises.                                               |
| **CE16** Fork, lineage spec | Unchanged. "Fork a new thread here" in the tree opens today's fork dialog at that point. Labels on the copied path travel with the fork (CT9).                                                                                      |
| **CE18** Title, hover card  | The title is generated once and locked by rename; a root branch never re-titles (Q27). The hover card gains a junction count (CT12).                                                                                                |
| **CE19** Organisation       | Labels and leaf moves are owner actions (`lockForChange`), as pin and archive are; labels are not audited (Q11). Browsing never writes.                                                                                             |
| **CE20 / D23** Sharing      | A reader sees the whole tree of a thread shared with them and browses every branch through the local head; they cannot move the leaf, label, or summarise.                                                                          |
| **D18** Retention, export   | A leaf move is never activity. Export gains every branch (CT14).                                                                                                                                                                    |
| **D31** Audit               | Labels not audited. A branch summary is a run: audited as compaction is (`thread.branch_summarized`).                                                                                                                               |
| **TH** Theming              | Eight lane tokens per preset, light and dark, contrast-tested (CT7).                                                                                                                                                                |
| **CV** Context viewer       | Already classes `branch_summary` entries as `other`. The gauge is per branch in effect; CT16 warns before making a branch current that exceeds the model's window.                                                                  |

## 3. Today (what the code does, verified 2026-11-05)

- `thread_entries` mirrors Pi's session one to one: `entry_id`, `parent_id` (index
  `thread_entries_parent_idx` on team, thread, parent). `threads.leaf_entry_id` is the branch Pi
  continues on; `POST /v1/threads/{id}/leaf {entry_id}` moves it (`setLeaf`, repository.ts:
  owner only, refused in Trash and while a run is running or waiting for approval,
  `thread_busy`; **not** refused while runs are queued; no rate limit).
- A message may be sent with `parent_entry_id` (`submitMessageBodySchema`): the run starts by
  having the sandbox agent append a `custom` entry `kobe.branch` `{run_id}` under that parent while
  Pi is stopped (`appendBranchMarker`, `pi/session-files.ts`); Pi resumes at its last appended
  entry, so the prompt lands on the new branch. The marker never enters model context. Runs
  record `parent_entry_id` and `user_entry_id` (`runs`), so a run maps to its node.
- The web loads **all** entries of a thread, inactive branches included, and `projectThread`
  (`lib/chat/tree.ts`) turns them into assistant-ui's branchable message list (`parentId` +
  `headId`): one user message per `user` entry, one assistant message per chain of assistant-side
  entries, other entries folded into the message around them as markers (model change,
  compaction); a branch marker with nothing under it is an "empty version" (`EMPTY_VERSION_NOTE`).
  The head **is** the thread's leaf: the branch picker (`BranchPicker`, "Version n of N", in
  `ForkMarker` "Forked here · N branches", `markers.tsx`) calls `switchLeaf`
  (`unstable_onBranchChange`, `kobe-runtime.tsx`), which writes the leaf and, for a reader, fails
  (owner-only route; the picker is not gated on `readOnly`). The controller drops the follow-ups
  on a switch.
- Branches are made by Edit (`branchAndSend`), Regenerate, Regenerate with… (`regenerate-with.tsx`)
  and Retry; all branch from the edited prompt's parent (`branchPoint`). Nothing branches from an
  assistant message except Fork, which makes a new thread (`forkPointOf`: an answer forks at its
  last entry; a prompt at the entry before it with the prompt as draft).
- Pi 1.0 writes a settings entry at the session root, so a new first message is a root branch
  under that hidden entry (`tree-root-branches.test.ts`, KOBE-214).
- Compact now (CE15, `runs/compaction.ts`): a run of kind `compaction`, created running under the
  thread lock, delivered as `thread.compact`; Pi writes the `compaction` entry, the replica
  mirrors it, audits `thread.compacted`. The same shape serves CT11.
- Pi's RPC `get_tree` answers `{tree: [{entry, children, label?, labelTimestamp?}], leafId}`, so Pi
  itself keeps labels, but only its TUI sets them; the sandbox agent refuses `fork` (it would move
  Pi off the thread's session file) and `get_tree` can exceed one wire frame (`frame_too_large`).
  Pi's RPC has no "navigate to entry with a summary" command (rpc-commands.md, Pi 1.4): the TUI's
  `/tree` summarises through the SDK. Hence CT11 goes through Kobe's Pi extension, after a spike.
- `session.restore` rebuilds a sandbox's session file from entries under a byte cap
  (`restoreMaxBytes`); whether inactive branches are restored is **not verified** (spike, CT11).
- The hover card (`GET /v1/threads/{id}/card`, CE18) counts messages across all branches, capped
  at 1,000. The thread summary carries `leaf_entry_id`. `thread.updated` carries only the title.
- Search (`GET /v1/threads?q=`) answers `matched_entry_id`, which "may be on an inactive branch";
  the web stores it (`matchedEntryId`) and does nothing with it.
- Export (`retention/export.ts`) writes the active branch as the Markdown transcript; other
  branches are not exported.
- Runs record no file changes; memory writes record `run_id` (`memory_doc_versions`); approvals
  record `run_id` and `remembered`. The workspace is one filesystem per thread: branches share it.
- Panels over the workspace (`lib/shell/panels.ts`, KOBE-452): Threads, consoles, the context
  viewer open as large overlays with their own address; the chat stays mounted under them.

**Pi parity.** What `/tree` offers and what Kobe will have:

| Pi `/tree`                                  | Kobe                                                    |
| ------------------------------------------- | ------------------------------------------------------- |
| see every branch of the session, every row  | Conversation tree view, one row per turn (CT4)          |
| select a user message → text back in editor | Edit this message from the tree (CT8)                   |
| select any other entry → continue after it  | Continue from here (CT8)                                |
| summary of the branch left                  | Make it current and carry a summary (CT11)              |
| labels on tree nodes (TUI only)             | Labels on any node, Kobe-side (CT9)                     |
| `/fork` → new session from a user message   | Fork a new thread here (today's fork dialog, unchanged) |
| `/clone`                                    | Fork at the last answer (unchanged)                     |
| not in Pi: browse without moving the leaf   | Local head (CT3)                                        |
| not in Pi: two answers side by side         | Compare versions (CT10)                                 |
| not in Pi: what a branch left behind        | Badges: files, memories, approval rules (CT6)           |

## 4. Decisions

**CT1. No new read for the tree: it is a second projection of the entries the web already has.**
`lib/chat/tree.ts` gains `projectTree(entries, head, leaf, notes, live)` beside `projectThread`,
sharing its turn-collapsing rules so a node in the tree is exactly a message on screen
(`nodeOfEntry` / `lastEntryOfNode` are reused, never recomputed differently). A node:

```ts
{ id: string,            // the message id (its first entry), as projectThread gives it
  parentId: string | null,
  role: "user" | "assistant",
  excerpt: string,       // text, whitespace collapsed, 120 chars; "(tools only)" for a tool-only turn
  at: string,            // created_at of the first entry
  model: string | null,  // the model recorded on the branch at this node (markers' `model` chain)
  agentVersion: { name: string, version: number } | null,   // when an agent switch is recorded here
  tokens: { input: number, output: number } | null,   // Pi's usage on the assistant message, when recorded
  onScreen: boolean,     // on the path root → head (the conversation on screen, CT3)
  isLeaf: boolean,       // the thread's leaf (where Pi continues)
  empty?: true,          // a branch marker with no message under it (an interrupted run), CT5
  badges: { files?: number, memories?: number, rule?: true },   // CT6
  summary?: { entryId: string },   // a branch_summary entry folded into this node (CT11)
  label?: string }       // CT9
```

plus `lanes`: the git-graph layout (CT4). The live run's streaming message is a node too (dashed).
Tokens come from Pi's usage on the entry (Q15); the tree shows no money figure. _Rejected:_
`GET /v1/threads/{id}/tree` on the server: it would duplicate the web's turn collapsing, and the
web holds every entry already (the branch picker depends on it). _Rejected:_ run cost per branch
(a runs read; the tree is for returning to a version, not accounting).

**CT2. One read for what the web cannot derive: `GET /v1/threads/{id}/branches`.** For any viewer
who may read the thread:

```jsonc
{
  "labels": [{ "entry_id": "…", "label": "try 5% cut" }], // CT9, at most 200
  "runs": [{ "user_entry_id": "…", "remembered_rule": true }], // runs of this thread that wrote a remember-rule (approvals.remembered), by their prompt entry
}
```

Read when the thread opens (with the lineage, TL4's triggers: open, window focus when older than
60 s) and after a label change. Never pushed. A failed read shows the tree without labels and
badges, no error box.

**CT3. The local head.** The conversation on screen follows a **client-side head** kept by the
runtime per open thread, separate from the thread's leaf. It starts at the leaf, follows the leaf
whenever the leaf moves (a send, the picker, another tab's move through CT13), and is moved
locally by: a click in the tree (CT4), a search hit on another branch (CT15), and, for a reader,
the branch picker. Browsing never writes. While the head is not the leaf the conversation shows a
bar under the lineage strip:

```
⑂ Showing another branch · 3 messages differ      [Make it current]   ✕
```

- **Make it current** (owner only) calls `POST /leaf` with the head's branch leaf; the bar goes.
  Refused `thread_busy` while a run is running, waiting, **or queued** (Q7: the leaf never moves
  under a queued prompt; the note says "wait for the queued runs"); refused in Trash. Rate limit
  `LEAF_RATE` 120 per 10 min per member (Q24). The follow-ups are dropped as today.
- **✕** returns the head to the leaf.
- **Sending** from a browsed branch (owner) makes it current first: the message goes with
  `parent_entry_id` = the head's last entry, which is how an edit branches today, and the leaf
  follows Pi's commit. One send, no extra call. The composer says "Sending here makes this branch
  current" under the chip.
- **The picker arrows** keep today's behaviour for the owner (they move the leaf, Q21) and move
  only the head for a reader (the route is never called read-only; today's failure goes away).
- Edit, Regenerate, Regenerate with… and Retry on a browsed branch work as they do on the leaf's
  branch (they already send `parent_entry_id`).
- The head is per tab, in memory; reopening a thread starts at the leaf.

**CT4. The Conversation tree view.** Opened from a header button "⑂ Tree" (CT12), the command
palette ("Conversation tree"), the `ForkMarker` row ("Forked here · 3 branches" becomes a link)
and the bar of CT3. It opens as the panels over the workspace do (`PanelId` `conversation-tree`,
address `/tree`, the chat mounted under it, Escape and Close return to the conversation; a reload
keeps it open, Back closes it). It draws one SVG git-graph, **every turn, one row each, nothing
folded** (Q3, as Pi), newest turn at the bottom, time flowing down:

```
Conversation tree · Budget 2027                      3 branches · 2 forks   ✕
│
● Plan the Q3 budget                                              12:04
│
●─┐ Redo Q3 with the new headcount                                12:11
│ │
│ ●  "try 5% cut" · gpt-5 · 3.1k tokens · 📄 2 files · 🧠 1 memory  12:14   ← labelled; badges
│ │
│ ○  no answer (run interrupted)                                  12:16   ← ghost node
│ │
│ ○  summary carried into the branch below                        12:20   ← CT11
│
● │ Use the June actuals instead · claude-… · 2.4k tokens         12:18   ◀ on screen · leaf
│ │
├╌╌ ⑂ Budget 2027 — marketing cut   (fork, another thread)                ← from lineage, link
│
▼
```

- **Lanes.** Depth-first from the root: the path to the head takes lane 1; each other branch
  takes the next free lane at its branch point, newest sibling first, and frees it after its last
  node. Rows are ordered by the first entry's `seq`, so a branch made later sits below the one
  made earlier, as a git log does. No library: the layout is a DFS with a free-lane list
  (`lib/chat/tree-layout.ts`, pure, tested), rendered as `<svg>` lines and circles plus HTML rows
  for the text (so text wraps, selects and is read by screen readers). Lanes are capped at
  `TREE_MAX_LANES` (8); a branch past that is drawn in lane 8 with a dotted link.
- **Nodes.** A user node is the prompt's excerpt in the body colour; an assistant node is the
  answer's excerpt in muted text with model, tokens and badges as a trailing note; a tool-only
  turn says "(tools only)". The node on screen has a "◀ on screen" chip, the leaf a "leaf" chip
  (both when they coincide). The live run's node pulses, as the composer's stop control does. A
  label shows in bold before the excerpt. A ghost node (CT5) is hollow. A folded branch summary
  shows the "○ summary carried" row under its node (CT11). Markers that the conversation shows
  between messages (model change, agent switch, compaction) are not nodes: a model or agent change
  is the trailing note's text at the first node after it; a compaction shows as a small
  "compacted above" tick on the lane.
- **Forks.** The lineage read (TL1) is already in hand when the thread is open: the thread's own
  readable forks are drawn as dashed leaf rows off the node they forked from (`forked_at_entry_id`
  maps to a node through `nodeOfEntry`; a fork point on an inactive branch is drawn there),
  labelled with the fork's title, as links that open the fork. Ancestors are not drawn: the strip
  already shows them. So one picture spans "branches here" and "threads from here".
- **Click.** Clicking a node moves the **head** (CT3) to the node's newest descendant leaf (the
  branch picker's own rule), closes the view and scrolls the conversation to that node's message;
  the bar offers Make it current. Nothing is written. Owner and reader alike (Q21).
- **Node menu** (⋯ on hover/focus, the context-menu key, Enter opens it on the focused node):
  Show in conversation (click); Make it current (owner, off the leaf's branch); Continue from
  here (assistant nodes, CT8); Edit this message (user nodes, CT8); Retry (ghost nodes, CT5);
  Label… / Remove label (owner, CT9); Compare with… (nodes with siblings, CT10); Make it current
  and carry a summary (owner, off the leaf's branch, CT11); Fork a new thread here (today's dialog
  at that node's fork point); Copy text.
- **Header.** The thread's title, "N branches · M forks" (branches = junctions, CT12; forks = the
  lineage's `forks`), a filter box that dims nodes whose text or label does not match, and Close.
- **Keyboard.** ↑/↓ move between rows, ←/→ between siblings at a branch point, Enter shows the
  branch, Home/End root and leaf, `/` focuses the filter, the context-menu key opens the node
  menu. The rows form a `role="tree"` with `aria-level` = lane, `aria-selected` on the focused
  row, `aria-current="true"` on the node on screen; each row's accessible name is "<role>,
  <excerpt>, <time>, <label>, <badges>". No global chord: the palette lists "Conversation tree",
  "Previous version", "Next version", "Continue from here" (Q29).
- **Empty.** A thread without branches or forks still opens the view (a straight line), with the
  note "No branches yet. Edit a message or choose Continue from here on an answer to start one."
- **Draft threads** (no thread yet) have no button.
- **Performance.** The layout is recomputed on committed entries only (memoised on the entries
  array and the head); the live node is appended to the last layout without a relayout.

**CT5. Ghost nodes.** A branch marker with nothing under it (a run that was interrupted before
its prompt committed; the projection's empty version) is drawn as a hollow node "no answer (run
interrupted)" with Retry in its menu (Q19). It counts as a version in the picker, as today, so
the two views agree.

**CT6. Badges: what a branch left behind.** Branching the conversation does not branch the
workspace, the memory or the approval rules. The tree says so per node (Q25) and on switch (Q6):

- **📄 N files**: the assistant node's run changed files, counted client-side from the branch's
  tool calls in the entries (Pi's write and edit tools; a shell command that writes is not seen).
  The badge's tooltip lists the paths.
- **🧠 N memories**: memory writes in the node's tool calls (the memory agent's write tools),
  counted the same way; the tooltip links to My memory.
- **🔏 rule**: the node's run wrote a remember-rule (CT2's `runs[].remembered_rule`); the tooltip
  links to the team's approval rules.
- Making another branch current when the branch being left has a files badge shows, in the
  Make-it-current confirmation, "Files changed on the branch you are leaving stay changed; the
  workspace is shared by every branch." Memories and rules get one line in the tree's help text:
  "Memories and approval rules written on a branch stay in force." Nothing is undone, ever;
  snapshot-and-restore of the workspace per branch is a workspace-sync feature for a separate spec.

**CT7. Lane colours.** Each theme preset defines `--kobe-lane-1` … `--kobe-lane-8` for light and
dark (Q28): lane 1 is the preset's accent (the path on screen), lanes 2–8 are distinct hues
chosen for contrast on the preset's surface. The theming tests check each lane's contrast
against the surface for every preset in both modes, as the accent floor is checked today.
Ghost nodes and summary rows use the muted foreground, not a lane colour. _Rejected:_ hue rotation
at runtime (no contrast guarantee) and one shared palette (clashes with presets).

**CT8. Continue from here, and Edit from the tree.**

- **Continue from here** on any assistant message that is not live (the message's hover actions,
  the tree's node menu, the palette for the focused message): the head moves to the path ending
  at that answer with the messages that followed it **dimmed in place** (not hidden), the
  conversation scrolls to the answer, and the composer takes a **branch chip** "Continuing from
  the answer at “<excerpt>” ⑂ · ✕" and focus (Q5). The next send goes with `parent_entry_id` =
  the answer's last entry (the same entry the fork point names), through `branchAndSend` as an
  edit does, so the server, the marker and the leaf update are unchanged; the new prompt lands as
  a sibling of whatever followed that answer. Escape, the chip's ✕ or sending clears the chip and
  the dimming; opening another thread drops it. Not offered on the leaf's own last answer (there
  is nothing to branch from). Nothing is written until the send. _Rejected:_ moving the leaf at
  once: it would hide the messages below until the member sends, and a change of mind would have
  moved Pi's leaf for nothing.
- **Edit this message** on a user node: closes the view, moves the head to that node's branch and
  opens the message's inline editor (the same path as the message's own Edit action), so the
  member sees what they edit. Submitting branches from the prompt's parent exactly as Edit does.
  This is Pi's "select a user message → text back in the editor", without a second code path.

**CT9. Labels.** A short name on **any node** (Q10): a branch's first message or any point on a
straight run ("the good answer"). Kept by Kobe on the node's first entry; owner only; every
reader sees them; never model context, never in the session file (Q9), never in export's
conversation body (export's metadata gains `labels: [{entry_id, label}]`). Not audited (Q11:
personal organisation, CE19). Table `thread_branch_labels` (area `conversations`):

```
team_id uuid NOT NULL → teams ON DELETE CASCADE
thread_id uuid NOT NULL
entry_id text NOT NULL
label text NOT NULL        CHECK char_length(btrim(label)) BETWEEN 1 AND 60 AND label = btrim(label)
created_by uuid NOT NULL → users (NO ACTION)
updated_at timestamptz NOT NULL DEFAULT now()
PRIMARY KEY (team_id, thread_id, entry_id)
FOREIGN KEY (team_id, thread_id) → threads (team_id, id) ON DELETE CASCADE
FOREIGN KEY (team_id, thread_id, entry_id) → thread_entries (team_id, thread_id, entry_id) ON DELETE CASCADE
ENABLE + FORCE ROW LEVEL SECURITY, policy on current_setting('kobe.team_id')
```

At most `BRANCH_LABELS_MAX` (200) per thread (checked under the thread's row lock).

- `PUT /v1/threads/{id}/labels/{entryId}` `{label: string | null}` → 200 the `branches` body
  (CT2); `null` removes. Owner only (`lockForChange`), refused in Trash (`thread_in_trash`) and on
  builder test, Workbench and eval threads (`test_thread`, Q23), 404 `entry_not_found` for an
  entry not in this thread; idempotent; never activity. Rate limit 60 per 10 min per member, as
  folder create. The web offers Label… only on committed entries (an entry still streaming, or
  one mirrored only at the next run start, has no row yet).
- A fork copies the labels of the copied path (same entry ids) in the fork's transaction (Q12);
  the fork's owner may change them.
- Trash keeps labels; purge removes them with the thread (the key).
- Labels show in the tree (bold before the excerpt), in the branch picker when the labelled node
  is a branch's first message ("Version 2 of 3 · _try 5% cut_"), in the Compare header, and in
  the tree's filter. Plain text, trimmed, 1–60 chars, one line, the same character rules as folder
  names (Q30).

_Rejected:_ Pi's own label entries (writing one needs the thread's Pi stopped and the sandbox
awake, or a second entry-sync path; and D15 mirrors Pi's file into Postgres, never the other
way). _Rejected:_ a column on `thread_entries` (the mirror stays Pi's shape).

**CT10. Compare versions.** In this lane, its own ticket after the tree (Q16): the picker's
Compare icon and the tree's menu item appear when it ships. From the branch picker (a "Compare"
icon beside the arrows when N ≥ 2), the tree's node menu, or the palette: a dialog (the chat's
portal, full-screen under 820 px) with two columns, each an answer to the same prompt rendered
read-only as the conversation renders it (markdown, tool cards collapsed, no actions but Copy),
headed by its label or "Version k", model, time and tokens, with the answer feedback control
(KOBE-467 lane) under each, and a "Show this version" button that moves the head (CT3) and
closes. With more than two versions each column has a dropdown of the others. Compare is
view-only. Prompts (user nodes) are compared the same way when a prompt was edited: the two
prompts and their first answers.

**CT11. Make it current and carry a summary.** Owner only, on a node off the leaf's branch (tree
menu, and the bar's "Make it current ▾ · and carry a summary"). A dialog like Compact now's: what
will happen ("Pi summarises the 4 messages on the branch you are leaving and puts the summary
into the branch you switch to; it costs a model call"), an optional one-line focus, Go. Then:

- `POST /v1/threads/{id}/branch-summary` `{to_entry_id, focus?}` → a **run of kind
  `branch_summary`**, created running under the thread lock exactly as compaction is (busy or
  queued → `thread_busy`, never queued; a shared reader 403 `read_only`; a test thread
  `test_thread`), delivered as `thread.branch_summary {from_leaf_entry_id, to_entry_id, focus}`.
- The sandbox agent, with the thread's Pi awake, asks Pi for the summary through **Kobe's Pi
  extension** (the one that registers Kobe's models, `kobe-models/register.ts`), which calls the
  SDK path Pi's own `/tree` uses to summarise the entries between the common ancestor and the
  old leaf and to append a `branch_summary` entry whose parent is `to_entry_id`. Pi owns the text
  (as for compaction). The agent reports the new entry; the replica mirrors it, sets
  `leaf_entry_id` to it, ends the run and answers the member. The thread's session is now on the
  new branch with the summary as its last entry, so the next prompt sees it.
- **Never automatic; one per switch; at most `BRANCH_SUMMARIES_MAX` (20) per thread** (Q14): the
  21st is refused `summary_limit` with "Compact the thread first".
- Errors mirror compaction's fixed messages (`thread_busy`, `sandbox_unavailable`,
  `model_not_configured`, `nothing_to_summarize` when the branch left has no message,
  `summary_limit`, `summary_failed`); the sandbox's text is logged, never relayed.
- Audited `thread.branch_summarized {threadId, runId, outcome, focused?}` (team, like
  `thread.compacted`). The run counts against the budget like any run.
- In the conversation the entry shows as a new marker kind `branch_summary` beside `compaction`
  ("Summary of another branch", folded, with the text) on the branch it entered; the context
  viewer lists it as `other`. The tree shows it as the "○ summary carried" row (CT4).

**Spike first (Q13).** A half-day ticket before anything is built answers two questions: (a) does
Pi 1.4's SDK let an extension running inside the Pi process summarise a branch and append the
entry (the path the TUI's `/tree` uses); (b) does `session.restore` put inactive branches back
into the session file (else the command must carry the branch's entries). CT11 ships as the last
ticket of the lane only if both answers are yes; otherwise it is dropped from the lane and
waits for a Pi release, and the ledger says so. Sending Pi `compact` instead is **not** an
acceptable substitute: it folds the branch being entered, not the one left.

**CT12. Header button and hover card: junctions.** A **branch** is a junction: an entry with more
than one child (Q20); the root's hidden settings entry counts as an entry, so two first messages
are one junction. The conversation header gains "⑂ Tree" (hidden on a draft; with the junction
count as a badge when there is one, or the fork count), opening CT4; the `ForkMarker` row's "N
branches" becomes the same link. The hover card (`GET /v1/threads/{id}/card`) gains
`branches: n` counted server-side over `thread_entries_parent_idx` (parents with more than one
child), capped at 1,000 with the message count's `capped` flag; the rail row's hover card shows
"3 branches" beside the message count. The thread summary is unchanged (no per-row query).

**CT13. The leaf on the wire.** `thread.updated` gains `leaf_entry_id` (additive, D16; Q8), sent
on every leaf move (the route, a send's commit, a summary run) to every stream of the thread.
Open tabs re-project at once: a tab whose head was at the old leaf follows the new leaf (CT3); a
tab browsing another branch keeps its head and its bar updates. Readers see the owner's branch
move live. The focus re-read of the summary stays as the fallback for a dropped stream.

**CT14. Export: every branch.** The export zip (`retention/export.ts`) keeps
`transcripts/<date>-<title>-<id>.md` as the leaf's branch and adds
`branches/<date>-<title>-<id>/<n>-<label-or-first-words>.md` for every other leaf's path, each
starting with "Branched from message <k> of the main transcript: “<excerpt>”" (Q17). Labels in
the per-thread metadata. Paths and labels are slugged as titles are. The streamed, paged reading
is unchanged: the walk collects every leaf's id set, not only the active one.

**CT15. Search hits open on their branch.** Opening a hit whose `matched_entry_id` is off the
leaf's branch moves the **head** to that branch (owner and reader alike), scrolls to the matched
message and shows the bar of CT3 (Q18). The thread's leaf is untouched. The hit note under the
rail row says "on another branch".

**CT16. Context and schedules.** The context gauge already reflects the branch in effect; CT3
makes it follow the head. Make it current on a branch whose context exceeds the model's window
(the gauge's own estimate) shows "This branch is longer than the model's window; compact after
switching" and proceeds (Q26; refusing would leave no way to compact that branch, since
compaction runs on the leaf). On a scheduled thread the bar adds "The schedule will continue on
this branch." Compaction entries belong to the branch they were written on, as today.

**CT17. Title.** Generated once after the first run and locked by rename (CE18); making a root
branch current never re-titles (Q27). The tree's header shows the title.

**CT18. Narrow windows (under 820 px).** The panel is the full-screen sheet and shows a **list
grouped by junction** (Q22): each junction is a section headed by the prompt above it; its
branches are rows with label, excerpt, time, badges and the "on screen" and "leaf" chips; a row
opens that branch (head), its ⋯ holds the node menu. A thread without junctions shows the empty
note (CT4). The lineage strip collapses the same way on a phone.

**CT19. Test threads.** Builder test, Workbench and eval threads open the tree, use the local
head, Continue from here and Compare; Label and carry-a-summary are refused `test_thread` and not
offered (Q23), as Fork is.

**CT20. Protocol.** `packages/protocol/src/threads.ts` gains `threadBranchesResponseSchema`,
`setLabelBodySchema`, `BRANCH_LABEL_MAX_CHARS`, `BRANCH_LABELS_MAX`, `LEAF_RATE`; `threadCardSchema`
gains `branches`; `thread.updated` gains `leaf_entry_id` (optional on the wire for old events);
the run kind enum gains `branch_summary` with `branchSummaryRequestSchema`, its error codes and
HTTP statuses beside `compactThreadRequestSchema`, and `BRANCH_SUMMARIES_MAX`. All additive. Pi's
`fork`, `clone`, `switch_session` and `get_tree` remain outside the sandbox-agent contract; CT11's
summary is the only new sandbox command, delivered under the run lock like `thread.compact`.

## 5. Interaction details and limits

| Item                     | Value                                                          |
| ------------------------ | -------------------------------------------------------------- |
| Node excerpt             | 120 chars, whitespace collapsed                                |
| Rows                     | one per turn, never folded                                     |
| Lanes drawn              | 8; further branches share lane 8, dotted                       |
| Lane colours             | `--kobe-lane-1..8` per preset, light and dark, contrast-tested |
| Label                    | 1–60 chars, trimmed, one line                                  |
| Labels per thread        | 200                                                            |
| Label write rate         | 60 per 10 min per member                                       |
| Leaf move rate           | 120 per 10 min per member                                      |
| Leaf move refused        | run running, waiting for approval, or queued; Trash            |
| Compare columns          | 2 at a time, dropdowns for the rest                            |
| Branch summaries         | one per switch, never automatic, 20 per thread, owner, idle    |
| Branch summary run       | up to compaction's 10 min                                      |
| Branches (count)         | junctions: parents with more than one child, capped at 1,000   |
| Tree width               | the panel's; full-screen sheet, list by junction, under 820 px |
| `branches` read on focus | when older than 60 s (with the lineage)                        |

Accessibility: the tree is `role="tree"` with arrow keys, Home/End, Enter and a context menu on
every row; the SVG is `aria-hidden`, the rows carry the content; badges have text equivalents in
the row's accessible name; the compare dialog is a Radix dialog with the two columns as labelled
regions; every mouse path (click, hover actions) has a palette or menu path. Announcements
("Showing another branch", "This branch is now current", "Label saved") go through the chat's
polite region.

## 6. Security

Every route runs inside `withTeam()` under RLS; a label of another team's thread answers 404.
Labels are written only by the owner (`lockForChange`) and read by whoever may read the thread;
they are rendered as text, never HTML, and never reach the model, the session file or the
sandbox. The local head is client state: browsing writes nothing, and a reader's browsing never
reaches the leaf route. The leaf route is rate-limited and refused under any run. A branch
summary is a run: it needs `team.chat`, the thread's owner, an idle thread, and is budgeted,
leased and audited like compaction; its text is Pi's, mirrored like any entry, and the sandbox's
error text is never relayed. The tree view shows only entries the viewer already has; forks drawn
in it come from the lineage read, which reveals nothing unreadable (TL1); the `branches` read
names runs of this thread only. Badges are derived from the viewer's own entries and from the
`remembered` flag, never from another thread. Continue from here writes nothing until a send,
which is an ordinary message submit with `parent_entry_id`, validated as today. Export adds no
content the owner could not already read.

## 7. Out of scope

Deleting or hiding a branch (Pi never deletes; neither does Kobe), moving a branch to another
thread (that is Fork), merging branches, cross-thread trees beyond the forks row (the lineage
strip covers ancestors), Pi's `/clone`, labels set from inside the sandbox, run cost per branch,
snapshot and restore of the workspace per branch (a workspace-sync spec), undoing memories or
approval rules written on a branch (links only, CT6), a global keyboard chord for the tree.

## 8. Questions and Chris's decisions (2026-11-05)

1. **Primary job.** _Return to an earlier version._ Switching is the first action everywhere;
   compare and badges are secondary (CT4's menu order, CT3).
2. **Placement.** _A panel over the workspace_, like Threads and the context viewer (CT4).
3. **Folding.** _Everything, one row per turn, like Pi._ No folding (CT4).
4. **Readers.** _A local head_: readers browse every branch, write nothing (CT3).
5. **Continue from here.** _Chip and view_: the composer chip, and the conversation shows the path
   to that answer with the later messages dimmed, scrolled to the answer (CT8).
6. **Workspace files.** _Warn on switch and badge nodes_; no snapshot or restore (CT6).
7. **Queued runs.** _Refuse the leaf move while anything is queued_ (CT3).
8. **Second tabs.** _The leaf on `thread.updated`_ (CT13).
9. **Where labels live.** _A Kobe table, never in Pi's session_ (CT9).
10. **Label scope.** _Any node_; shown in the picker only on a branch's first message (CT9).
11. **Label audit.** _None_ (CT9).
12. **Fork and labels.** _A fork copies the labels on the copied path_ (CT9).
13. **Branch summaries.** _Spike first, then the last ticket, droppable_ (CT11).
14. **Summary cap.** _One per switch, never automatic, at most 20 per thread_ (CT11).
15. **Node cost.** _Tokens from Pi's usage on the entry_; no money figure, no new read (CT1).
16. **Compare.** _This lane, its own ticket after the tree_ (CT10).
17. **Export.** _Every branch, each its own transcript_ (CT14).
18. **Search hits.** _Show the hit's branch through the head, leaf untouched_ (CT15).
19. **Empty versions.** _Ghost nodes with Retry_ (CT5).
20. **Branch count.** _Junctions, in the header and on the hover card_ (CT12).
21. **Owner's click.** _Shows the branch locally; Make it current moves the leaf; a send from a
    browsed branch makes it current first; the picker arrows keep moving the leaf_ (CT3, CT4).
22. **Narrow windows.** _A list grouped by junction_ (CT18).
23. **Test threads.** _Tree, head, continue and compare work; no labels, no summaries_ (CT19).
24. **Leaf rate.** _120 per 10 min per member_ (CT3).
25. **Side effects.** _Badges on nodes_ for files, memories and approval rules; leaving a branch
    never undoes them (CT6).
26. **Context and schedules.** _The gauge recomputes; warn when the branch exceeds the window;
    note the schedule on the bar_ (CT16).
27. **Title.** _Stays unless the member renames_ (CT17).
28. **Lane colours.** _Distinct per lane: eight tokens per preset, accent first, contrast-tested_
    (CT7).
29. **Keyboard.** _Command palette only; the tree's own keys while open; no global chord_ (CT4).
30. **Label limits.** _Accepted_: 1–60 chars, 200 per thread, 60 writes per 10 min (CT9).
31. **Next step.** _Update the spec only_; tickets are filed after review.

## 9. Implementation tickets (filed 2026-11-06 as KOBE-541..549)

Order: CT-0 and CT-1 in parallel → CT-2 and CT-3 in parallel → CT-4 → CT-5 → CT-6 → CT-7 (only
if CT-0 said yes) → CT-8. Each ticket in a worktree per `docs/parallel-work.md`; one group branch
and one PR per group as the lane rule says.

- **CT-0 (KOBE-541) Spike: branch summaries** (sandbox agent): can a Pi 1.4 extension summarise a branch and
  append the entry; does `session.restore` restore inactive branches. A written answer in the
  ledger, no product code. Decides CT-7.
- **CT-1 (KOBE-542) Protocol shapes** (`packages/protocol`): `branches` read and label write schemas and
  limits, `branches` on the card, `leaf_entry_id` on `thread.updated`, run kind `branch_summary`
  with request and error schemas (CT20). Tests first.
- **CT-2 (KOBE-543) Server: labels, junction count, leaf rules, export**: table `thread_branch_labels`
  (migration, RLS, probe suite), the `branches` read with remembered-rule runs, the label write,
  fork copies labels, the hover card's junction count, `thread_busy` on queued runs and the leaf
  rate limit, `leaf_entry_id` on `thread.updated`, every branch in export (CT2, CT9, CT12, CT13,
  CT14). DB tests under `test:db`.
- **CT-3 (KOBE-544) Web: the local head** (`kobe-runtime.tsx`, `thread-controller.ts`): head separate from
  the leaf, the bar with Make it current, send-from-a-browsed-branch, the reader's picker, search
  hits on their branch, the leaf event (CT3, CT13, CT15, CT16's warning and schedule note).
- **CT-4 (KOBE-545) Web: tree projection, layout and lane tokens** (`lib/chat/tree.ts`, `tree-layout.ts`,
  theme presets): `projectTree`, lanes, excerpts, ghost nodes, badges from tool calls, forks from
  the lineage, `--kobe-lane-1..8` in six presets with contrast tests (CT1, CT4 data, CT5, CT6,
  CT7). Pure, unit-tested.
- **CT-5 (KOBE-546) Web: the Conversation tree panel, header button, Continue from here, Edit from tree,
  labels UI, the narrow list** (CT4, CT8, CT9 UI, CT12 button, CT18, CT19). Component tests;
  `PanelId` and address.
- **CT-6 (KOBE-547) Web: Compare versions** (CT10).
- **CT-7 (KOBE-548) Sandbox agent + server: branch summary run** (CT11): extension command, run kind, route,
  mirror, audit, cap, marker kind in the web. Only if CT-0 answered yes to both.
- **CT-8 (KOBE-549) Browser checks on gate1** (`e2e/browser`): branch from an answer, browse another branch
  as owner and as member2, make it current, label it, open the tree on a phone width, open a
  search hit on another branch, compare two versions, export and check `branches/`, carry a
  summary (if CT-7 shipped); ledger update.
