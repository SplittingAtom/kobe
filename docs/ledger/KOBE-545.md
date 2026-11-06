# KOBE-545: Tree projection, lane layout, badges and lane tokens (web, pure)

- **Status:** in review (not pushed; the coordinator opens the PR)
- **Branch / worktree:** `kobe-545-tree-projection` in `../Kobe-wt545` (from `kobe-544-local-head`)
- **Depends on:** KOBE-544 (local head), KOBE-542 (protocol `threadBranchesResponseSchema`)

## Plan

1. `projectTree` (CT1) on top of `projectThread`: nodes = its items, ghosts (CT5), badges (CT6),
   notes (CT2), live nodes; `junctionCount` (CT12). → `lib/chat/tree-nodes.ts`, `tree-badges.ts`
2. Git-graph layout (CT4) with fork rows and the memoised live append. → `lib/chat/tree-layout.ts`,
   `tree-forks.ts`
3. `branches` read: `api.getThreadBranches`, `useBranches` with `refresh`, fake route. →
   `lib/chat/branches.ts`, `use-branches.ts`, `testing/fake-kobe.ts`
4. Lane tokens (CT7) in the six presets and theme.css, tests, docs/theming.md §4.3 and §8 rule 6.

## Decisions

- **Nodes come from projectThread's items**, not a second walk: ids, parents and turn collapsing are
  the same by construction (ac-1). `tree.ts` re-exports `projectTree` / `junctionCount` (the module
  lives in `tree-nodes.ts` because tree.ts is already ~870 lines); `newestBelow` and
  `isSkippedSummary` are now exported, plus `isAppCardEntry` in entries.ts.
- **Ghosts** (CT5): the topmost `custom` entry (customType `kobe.branch` or none) with no message
  anywhere below it, id `empty:<entry>` (projectThread's id when it is the head), parent = the node
  holding its parent entry (null at the root). Not drawn while the live run's prompt is still on
  screen (projectThread's own rule). A head or leaf on a ghost entry puts `onScreen` / `isLeaf` there.
- **Node extras beyond CT1**: `seq` (row order), `live` (pulses), `pending` (uncommitted: dashed,
  never laid out), `compacted` (the "compacted above" tick on the node holding the compaction),
  `badges.paths` (tooltip, at most 20). Excerpt cut to 119 chars + "…"; ghosts have "" (the panel
  says "no answer (run interrupted)").
- **Model** = the branch's model at the node's last listed entry (`recordedModel` chain, so a
  `model_change` before a prompt shows on that prompt). **agentVersion** comes from the thread's
  agent markers (`notes.agents`, optional fields on `TreeNotes`, with `agentName`): the branches read
  has no agent data, so the panel passes the markers it already reads.
- **Tokens** = Pi's `usage` summed over the answer's assistant steps; input = input + cacheRead +
  cacheWrite (the gauge's prompt size), output = output.
- **Badges**: files = distinct paths of `write` / `edit` calls (sandbox-agent `TOOL_NAMES`),
  memories = `remember` calls (`TOOL_REMEMBER`; `recall` only reads); a call whose result is an
  error does not count. `rule` on the assistant node whose `promptEntryId` has
  `remembered_rule: true`.
- **Labels** map an entry to its node via `nodeOfEntry` (or its ghost); a label on the node's own
  first entry wins over one on an inner entry.
- **Layout**: chains = a node and its continuing child (the path's child on the path, else the
  oldest); lane 1 is reserved for the chain root → head; every other chain (other roots first, then
  depth-first, newest sibling first) takes the lowest lane 2–8 free over the closed row interval
  [parent row, last row]; none free → lane 8, `dotted`, no reservation. Fork rows sort right under
  their node and always take their own lane.
- **Live append**: `createTreeLayout(layout)` caches on (entries, head, forks) identity; pending
  nodes are appended (parent's lane when the parent ends its lane, else the next lane). Committed
  row objects are reused (`toBe`), and a spy proves no relayout.
- **Lane colours**: lane 1 = `var(--kobe-brand-link)` everywhere (the accent as text on the page,
  so Custom follows it); lanes 2–8 per preset and scheme: hues rotated from the accent in 45°
  steps, chroma per preset, lightness until ≥ 3:1 on every surface (all land at ≥ 3.9 light,
  ≥ 5.4 dark). Not mapped in tailwind.css (the SVG reads `var(--kobe-lane-N)`), so CSS snapshots
  are unchanged.
- **branches read** is wire-cased and zod-validated like the lineage read; failure → null → empty
  notes (`EMPTY_BRANCHES`), no error box. `useBranches` reads on open, on focus when older than 60 s
  or failed, and on `refresh()`.

## Open questions (for Chris or the coordinator)

- **Forks have no fork point in the lineage read**: `lineageRelativeSchema` (TL1) lists forks
  without `forked_at_entry_id`, so `treeForks` can only place forks given one (it counts the rest as
  `unplaced`). Placing forks needs an additive protocol field (`forks[].forked_at_entry_id`) in its
  own PR plus the server's lineage route; until then the panel can show "M forks" only.
- The panel (KOBE-546) should pass `useBranches`' notes plus the thread's agent markers as
  `TreeNotes`.

## Evidence (acceptance criteria → test or command output)

- **ac-1** `apps/web/lib/chat/tree-nodes.test.ts` "nodes are projectThread's messages": same ids and
  parents as projectThread, every version present, onScreen = root → head, isLeaf = leaf.
- **ac-2** `apps/web/lib/chat/tree-layout.test.ts`: lane 1 = head path for each version; newest
  sibling first; later branch below; lane freed and reused; ninth lane dotted in lane 8;
  `createTreeLayout` spy called once across live updates, committed rows identical.
- **ac-3** `tree-nodes.test.ts` "ghost nodes" and "notes, model, tokens, badges" (files/paths,
  failures excluded, memories, rule by prompt entry; `empty: true`).
- **ac-4** `apps/web/lib/theme/presets.test.ts` (rule 6 in the floor, "lane colours") and
  `apps/web/app/theme-css.test.ts` "lane tokens".
- branches read: `apps/web/lib/chat/branches.test.ts` (route, validation, failure, fake, hook
  triggers, late answer dropped).
