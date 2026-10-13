# KOBE-200: A4: Artifact column: tabs, auto-open, resize, remembered open set

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (PR #260)
- **Branch / worktree:** `kobe-200-artifact-tabs` in `../Kobe-wt200`
- **Depends on:** KOBE-197 (shell grid), KOBE-203 (IconAction), KOBE-205 (column scroll), KOBE-198

## Plan

CE6 on the KOBE-130 panel: tabs in the artifact column, auto-open, a resize handle against the
conversation (CE7 floors), the open set per thread in localStorage. Web only; no server change.

## Decisions

- **Files:** `lib/chat/artifact-tabs.ts` (pure: tab ops, storage, floors),
  `components/chat/artifact-state.tsx` (provider: tabs, the thread's artifact list, auto-open,
  width), `artifact-tab-strip.tsx` (tablist), `components/shell/artifact-resize.tsx` (handle).
  `artifact-panel.tsx` keeps the content and `OpenArtifactButton`.
- **One list read:** the provider reads `GET /v1/artifacts?thread_id=` (again on each artifact
  event) and gives it to both the tabs (titles, pruning) and `ArtifactList`, which no longer
  fetches on its own.
- **Tabs:** WAI-ARIA tabs, automatic activation; arrows/Home/End, Delete closes; close icons
  (`artifact-close`, "Close <title>") are out of the tab order, so the strip is one stop. Only the
  active tab's content is mounted, so switching back shows the latest version. The header's own
  close is gone (the tabs have one each); Escape still closes the active tab. Closing the last tab
  returns focus to the opener; the column is then empty (`.artifact:empty` → no track).
- **Auto-open:** `artifact.created` (version 1) on the live run, on a tool call or as a notice,
  opens once per artifact per page and makes it active, without moving focus (the member may be
  typing). Updates never reopen a closed tab. A reload mid-run replays the stream, so a tab closed
  during that run may reopen once.
- **Storage:** `kobe.artifactTabs:<team>:<thread>` = `{open, active}`; no tabs removes the key.
  Reads keep UUIDs only, deduped, at most 20; a bad active falls back to the last tab; blocked or
  garbled storage is no tabs. Tabs of artifacts missing from a successful list read are dropped
  (a failed read keeps them). A new conversation has no key until its thread exists.
- **Width:** default `calc((100% - rail) / 2)` (CSS var on `.grid`); a dragged width is set inline
  as `--kobe-artifact-width` and clamped by the ≥ 1100 px rule
  `minmax(360px, min(width, 100% - rail - 400px)) minmax(400px, 1fr)`, so a dragged width holds
  while it fits and comes back when the window widens (CE7). Handle: `role=separator`, value in
  px, arrows ±24, Page ±96, Home = 360 floor, End = conversation's floor; drag writes the grid var
  directly and commits once on release. In memory only, slot comment for A6 (KOBE-202).
- **Below 1100 px** the handle is hidden and the columns stay `1fr 1fr`: A5 (KOBE-201) owns the
  yield order and the overlay sheet there.
- **View-only:** no editor; members only read, step versions, download.
- **Files:** nothing in the column renders Files (KOBE-198 moved it to the rail); a test pins it.

## Open questions (for Chris or the coordinator)

- None blocking. Real widths still need the gate1 browser check (happy-dom has no layout).

## Evidence (acceptance criteria → test or command output)

- ac-1: `components/chat/artifact-tabs.test.tsx` "tabs (ac-1)" (open order, switch, close,
  keyboard) and "auto-open (ac-1)" (active, focus stays in the composer, an update doesn't
  reopen).
- ac-2: same file "resize (ac-2)" (default, keyboard and drag clamp to 360/400, commit on
  release), "the column is gone with the last tab"; `lib/chat/artifact-tabs.test.ts` floors;
  `components/shell/layout-contract.test.tsx` CSS contract.
- ac-3: same file "per-thread memory (ac-3)": reload restores tabs and active, a thread switch
  swaps the set, gone artifacts are dropped, garbled and blocked storage.
- Mutation check: removing auto-open or pruning fails its test.
- Existing `artifacts.test.tsx` unchanged except clearing localStorage between tests.
