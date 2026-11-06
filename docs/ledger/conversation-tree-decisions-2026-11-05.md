# Conversation tree: decisions (Chris, 2026-11-05)

1. Purpose: return to an earlier version. Switching is the primary action; compare and audit secondary.
2. Placement: panel over the workspace (PanelId, own address), like Threads and the context viewer.
3. Folding: everything, one row per turn, like Pi. No folding.
4. Readers: local head, client-side, separate from the thread's leaf; readers browse every branch, write nothing.
5. Continue from here: composer chip (send carries parent_entry_id) AND the conversation shows the path to that answer with the later messages dimmed, scrolled to the answer. Nothing written until send.
6. Workspace files: warn on switch + "files changed" badge on nodes whose run recorded edits. No snapshot/restore (future, separate spec).
7. Queued runs: leaf switch refused (thread_busy) while anything is queued, with the note "wait for the queued runs".
8. Multi-tab/readers: thread.updated event gains leaf_entry_id; tabs re-project at once.
9. Labels: Kobe table thread_branch_labels, never in Pi's session, never model context.
10. Label scope: any node; shown in the picker only when the node is a branch's first message.
11. Label audit: none (personal organisation, CE19).
12. Fork copies labels on the copied path.
13. CT8 summaries: spike ticket first (SDK path for an extension; restore puts inactive branches back); ships as the last ticket only if both yes; droppable.
14. Summary cap: one per switch, never automatic, at most 20 per thread; the 21st refused "compact the thread first".
15. Node cost: tokens from Pi's usage on the entry; no money figure, no new read.
16. Compare: this lane, its own ticket after the tree; picker icon and menu item appear when it ships.
17. Export: every branch; transcripts/<thread>.md = active branch, branches/<thread>/<label-or-n>.md per other leaf with a "branched from" line; labels in metadata.
18. Search hits: show the hit's branch via the local head (owner and reader), scrolled to the hit; leaf untouched; a "Showing another branch · Make it current" bar for the owner.
19. Empty versions (interrupted runs): ghost nodes "no answer (run interrupted)" with Retry in the menu.
20. Branch count: junctions (entries with more than one child), both header and hover card; card counts server-side, capped.
21. Owner click in the tree: shows the branch locally; "Make it current" bar moves the leaf; a send from a browsed branch makes it current first (parent_entry_id). Picker arrows keep moving the leaf for the owner.
22. Narrow (<820 px): a list grouped by junction (section per junction headed by its prompt; branch rows with label, excerpt, time; the one on screen marked).
23. Test threads (builder, Workbench, eval): tree, local head, continue, compare work; no labels, no summaries.
24. Leaf route rate limit: 120 per 10 min per member.
25. Side effects: badges on nodes ("files changed", "wrote N memories", "approved a rule"); leaving a branch never undoes them. Source: files + memories from the branch's tool calls (entries, client-side); remembered rules from approvals rows via the run (server, in the branch-notes read).
26. Context: gauge recomputes per branch; "Make it current" on a branch over the model's window warns "compact after switching"; scheduled threads: note "The schedule will continue on this branch."
27. Title: stays unless the member renames; a root branch never re-titles.
28. Lanes: distinct colours, eight tokens per preset (--kobe-lane-1..8, lane 1 = accent), light and dark, contrast-tested per preset.
29. Keyboard: command palette only; the tree's own keys while open; no global chord.
30. Label limits accepted: 1-60 chars, 200 per thread, 60 writes per 10 min.
31. Next step: update the spec only; tickets filed later.
