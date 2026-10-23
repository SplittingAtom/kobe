# KOBE-487: Web notices a new build and offers a reload

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (committed on the branch, not pushed)
- **Branch / worktree:** `kobe-487-new-build-reload` in `../Kobe-wt487`
- **Depends on:** none

## Plan

1. Build id: resolved once per `next build`, inlined into client and server code; `/api/build`
   reports it (no meta tag: removed in review, nothing read it).
2. Client watcher (`lib/build/build-watcher.ts`): focus/visibility, every 10 min, unknown
   events/tools, failed chunk loads; throttled; stale is final.
3. Banner in the root layout (`components/shell/new-build-banner.tsx`), every page.
4. Draft across Reload; error pages for chunk errors; browser spec.

## Decisions

- **Which id.** `apps/web/lib/build/build-id.ts` `resolveBuildId`: `KOBE_BUILD_ID` from the
  environment when given (Dockerfile `ARG KOBE_BUILD_ID`, e.g. `--build-arg
KOBE_BUILD_ID=local-<sha12>`), else `<base36 time>-<8 hex>` fresh per build. `next.config.ts`
  writes it back into `process.env` (build workers that reload the config agree), passes it as
  `env.KOBE_BUILD_ID` (inlined) and as `generateBuildId`, so `.next/BUILD_ID` matches. Not the git
  sha alone (`.git` is dockerignored, and a local rebuild of dirty code must still differ) and not
  the chart's image tag (runtime env would disagree with the client bundle). Every new web image
  therefore has a new id; replicas of one image share it. `turbo.json` build `env` lists it
  (strict env mode would strip it otherwise). The ARG sits after `COPY . .` so dependency layers
  stay cached.
- **Endpoint.** `GET /api/build` → `{"buildId": …}`, `cache-control: no-store`, unauthenticated
  (holds only the id). `/api/*` except `/api/auth` routes to web in the chart's ingress, and the
  proxy matcher already skips `api/`.
- **Checks.** First check goes at once; then at most one request per 30 s, except a chunk error.
  Overlapping checks share one request. An unreachable endpoint is "unchanged" except after a
  failed chunk load (a deploy is most likely rolling). Once stale, no more requests.
- **Unknown events.** The browser drops SSE events whose type has no listener, so the client
  cannot see an unknown type directly. `seq` is gapless per run (protocol `events.ts`), so a
  skipped seq in `lib/chat/stream.ts` is the signal; an event of this run that fails the zod
  contract is the other. Both call `noteUnknownInput()` (overridable via `onUnknown`). Nothing
  else changes: the event is still dropped as before. Review check of the server: seqs never
  skip (no per-viewer filter, whole-run compaction answers 410, epilogue takes the next seqs);
  the sources are cited in the comment in `stream.ts`.
- **Unknown tools.** `lib/build/known-tools.ts`: the server runs only `BUILTIN_TOOLS` and
  `mcp__*` (it denies anything else), so any other name means a newer build. `ToolCallCard`
  still renders the generic card and calls `noteUnknownInput()`. A model-hallucinated tool name
  also triggers one (throttled) check, harmless.
- **Never auto-reloads.** Only the Reload button reloads (`window.location.reload()`).
- **Draft.** There was no composer persistence across reloads (`ChatSession.#composerDrafts` is
  in-memory), so `lib/build/reload-draft.ts` + `components/chat/use-reload-draft.ts`: Reload
  sets a flag; each composer stashes its text on `pagehide` (only after Reload, so a cancelled
  unload keeps nothing extra) under its draft key (thread id or `new`) in sessionStorage, and takes
  it back once on mount. Text only: attachments, mentions and chips are not kept. Review: the
  stash expires after 10 min and sign-out (profile menu) clears it, so another person signing in
  on the tab never gets it.
- **Unsaved file edits.** Reused the existing `useUnsavedGuard` (`beforeunload`,
  `components/files/file-editor.tsx`, mounted by the artifact panel): the browser asks before the
  reload drops edits. Skill draft editors have their own guard.
- **Chunk errors.** `watchForNewBuild` listens (capture) for `error` on `/_next/static/` scripts
  and stylesheets and for `ChunkLoadError` / failed dynamic-import rejections. New `app/error.tsx`
  and `app/global-error.tsx` render `PageError`: a chunk error inside the layout marks the
  watcher stale (the layout's banner shows); in place of the layout it shows the banner itself.
  Other errors get "Something went wrong." + Try again (previously Next's default page).
- **Styling/CSP.** CSS module with theme tokens only (`--background`, `--border`,
  `--kobe-status-accent(-fg)`, `--ring`), so it paints on chat, consoles and sign-in alike; the
  button is the accent fill with its white text (KOBE-479). No inline scripts; the live region
  (`role=status`) is always mounted so the notice is announced.

## Open questions (for Chris or the coordinator)

- Deploys could pass `--build-arg KOBE_BUILD_ID=local-<sha12>` for a readable id (optional; the
  random fallback already changes per image). `publish.yml` was not changed.
- The browser spec was typechecked but not run (no local stack; not to be run on gate1 by
  instruction). Run it at the next deploy check.

## Evidence (acceptance criteria → test or command output)

- **ac-1** `lib/build/build-id.test.ts`, `app/api/build/route.test.ts`.
  Local `next build` + standalone server: `/api/build` → `{"buildId":"mvkm7aoi-3a13f69d"}`
  with `cache-control: no-store`; client and server chunks carry the same id, equal to
  `.next/BUILD_ID`.
- **ac-2** `lib/build/build-watcher.test.ts` (unchanged → quiet; newer → stale; throttle; focus,
  visibility, 10-min timer); `components/shell/new-build-banner.test.tsx`.
- **ac-3** `lib/chat/stream.test.ts` (skipped seq, contract failure), `lib/build/known-tools.test.ts`,
  `components/chat/unknown-tool.test.tsx` (generic card renders, check fires; not for `read`).
- **ac-4** `new-build-banner.test.tsx` (reload only on click/Enter), `lib/build/reload-draft.test.ts`,
  `components/chat/reload-draft.test.tsx` (draft back after a reload; nothing kept otherwise),
  `components/shell/profile-menu.test.tsx` (sign-out clears it).
- **ac-5** `build-watcher.test.ts` (chunk script error, ChunkLoadError rejection,
  `noteChunkLoadError`), `components/shell/page-error.test.tsx`.
- **ac-6** the unit tests above; `e2e/browser/tests/new-build-reload.spec.ts` (route-faked newer
  id, clock jump for the periodic check, keyboard Reload keeps the draft, no style-src violations).
