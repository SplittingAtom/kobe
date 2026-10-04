# KOBE-83: 49f: Skill editor in the browser

- **Status:** in review
- **Branch / worktree:** `kobe-83-skill-editor` in `../Kobe-wt83`
- **Depends on:** KOBE-78 (upload API), KOBE-84 (console style)

## Plan

Editor under the team console (`/admin/team/skills`, `/new`, `/[id]`) that builds a zip in the
browser and saves it through `POST /v1/skills`. Editing needs the current files, which KOBE-78 did
not expose, so one read-only route was added (coordinator-approved).

## Decisions

- **New route** `GET /v1/skills/:id/versions/:n/bundle` in `routes/skills.ts`: same `visible()`
  check as the other reads (404 for other teams, other users' personal skills, bad ids, missing
  versions), streams the stored canonical zip from `deps.blobs` with `application/zip`,
  `attachment`, `nosniff`, `private, no-store`. Not audited (the other reads are not).
  `TestResponse` gained `bytes` for binary assertions.
- **Libraries:** `fflate` (MIT, already a server dep) for zip; `yaml` (ISC, already a server dep)
  to split and write SKILL.md frontmatter. No license exceptions needed.
- **Editor model** (`lib/admin/skills/`): name, description, "other frontmatter" (YAML, kept
  verbatim), body, extra text files. The name is the slug, so it is read-only when editing.
  Files that are not UTF-8 text (or contain NUL) are listed read-only as "kept as is" and carried
  unchanged into the new version. Saving always sends a zip; the server repacks canonically.
- **Caps** (`limits.ts`, copy of the server's): 200 files, 10 MiB per file, 25 MiB unpacked, SKILL.md
  100 KiB, 16 KiB frontmatter, 240-byte paths, unsafe/duplicate (NFC, case-insensitive) paths,
  5 MiB packed. Download decoding checks declared sizes before inflating. The server stays the
  authority: its messages (409 unchanged, 429, 413) are shown as given.
- **Scope:** new skills choose team or personal; existing ones keep theirs. The section needs
  `team.skills.publish`, so plain members don't see it in the console (they can still use the API
  for personal skills). Changing that would need a permission for personal skills in `GET /v1/team`.
- `apiRequest` raw bodies accept bytes; `apiDownload` added for binary GETs.
- Styling: CSS modules reusing the agent builder's field styles and `--admin-*` tokens.

## Open questions (for Chris or the coordinator)

- Should members (personal skills only) get a console entry? Needs a permission they hold.
- No version history or diff view; the editor always opens the latest version.

## Evidence (acceptance criteria → test or command output)

- ac-1 (create and edit without a zip): `components/admin/skill-editor-pages.test.tsx` (create,
  validation errors, server refusal, edit with binaries kept) and `lib/admin/skills/*.test.ts`.
- ac-2 (save creates a new version): the same edit test posts a zip and shows "Saved as v3";
  server side `skills.db.test.ts` ("bundle download" and the existing version tests).
