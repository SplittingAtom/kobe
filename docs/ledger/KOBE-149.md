# KOBE-149: 54c share_file in kobe-tools and the agent broker

- **Status:** in review
- **Branch / worktree:** `kobe-149-share-file-tool` in `../Kobe-wt149`
- **Depends on:** KOBE-147 (files contract, merged). Server handler is KOBE-150 (not here).

## Decisions

- **Capability follows config, not hello.ack.** `hello.ack` carries no capabilities, so the agent announces
  `files` exactly when it has the kobe-tools extension (fd 4) **and** workspace sync (`pushPath`). The same
  boolean sets `KOBE_TOOLS_FILES=1` for Pi; the extension registers `share_file` only on `1` (read once, then
  removed from `process.env`). Old agent or old image: no variable, no tool, no capability. No change to
  launch args, fds or Pi's config (KOBE-111 and KOBE-169 areas untouched; one env var in `buildPiLaunch`).
- **Path confinement** (`tools/share-path.ts`, before anything is read or pushed): relative or absolute under
  the workspace root; no `..`, control characters, backslash, `.kobe/`; `lstat` of the target must not be a
  symlink (dangling too); `realpath(target)` must equal `realpath(root)/rel` (so no symlink in any component,
  inside or outside); regular file only (no FIFO/device/dir); size <= `FILE_SHARE_MAX_BYTES`. Fail closed on
  any fs error. The contract schema already rejects `..` at the channel (`invalid_input`).
- **Push** (`WorkspaceSync.pushPath`): hashes with `O_NOFOLLOW` + volume check (a swap after the path check
  fails there), returns the known entry when the content is already synced (no new rev), else uploads the
  blob and commits that one path. Conflict/refused/stale -> error; sync off or restore pending -> error.
  Every push failure is tool error `not_synced`; nothing is sent to the server.
- **Broker** (`tools/share-broker.ts`): order is path -> push -> `file.share` frame (`workspace` = pushed
  entry) -> relay `file.share_result` as the flat tool result. Pending is registered before the push so run
  end / thread close / lost connection answer exactly once and a late push sends no frame. Caps: 4 per
  thread, 16 total. No retry.
- **Extension client** accepts the file reply shape (all fields checked, else the channel closes);
  `frame-size.ts` also measures the `file.share` frame. `share_file` input is checked in the extension
  (strict keys, lengths from the contract constants, pinned by a test).
- Added `FileShareFrame` / `FileShareResultFrame` type exports to the protocol (additive).
- Not done here (server, KOBE-150): `file.share` handler, `policy/tool-inputs.ts` entry for `share_file`.
  `share_file` is already in protocol `BUILTIN_TOOLS`.

## Open questions

- Sharing under `uploads/` or `projects/` is allowed (they are synced files); say if it should be refused.
- `kobe-models*.real-pi` suites need `@kobe/db` built; not run locally (disk), CI runs them.

## Evidence

- ac-1 (Pi lists share_file; policy.check precedes file.share): `src/kobe-tools.share.real-pi.test.ts`
  (real Pi + real kobe-policy; no push or frame before allow).
- ac-2 (push before share; clear push error): same file ("pushes, then sends", "when the push fails"),
  `tools/share-broker.test.ts`, `workspace/sync.test.ts` (pushPath).
- ac-3 (no capability, no tool): real-Pi "announces the files capability only with...", "offers no
  share_file...", `kobe-tools/extension.test.ts`, `pi/pi-launch.test.ts`.
- Confinement: `tools/share-path.test.ts` (traversal, absolute outside, symlink out / in / dangling /
  directory, FIFO, `.kobe/`, size limit) and the real-Pi refusal cases.
