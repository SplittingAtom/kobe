# KOBE-79: 49b static skill scanner (pure library)

- **Status:** in review
- **Branch / worktree:** `kobe-79-skill-scanner` in `../Kobe-wt79`
- **Depends on:** none (KOBE-80 calls it on upload)

## Plan

New workspace package `packages/skill-scanner` (`@kobe/skill-scanner`, no runtime deps, same
config shape as `packages/agent-file`). `scanSkillBundle(files: {path, bytes}[])` returns
`{scripts, findings, skipped}`; each finding is `{category, rule, file, line, excerpt}`.

## Decisions

- Categories: `network`, `pipe-to-shell`, `package-install`, `obfuscation`, `secret`.
- Script rules run only on scripts (extension list or `#!` shebang); secret rules run on every
  text file, markdown included. At most one finding per category per line.
- Excerpts mask every secret-shaped value (first chars kept, rest `*`) and are cut to 200 chars.
- Bounds: files over 1 MiB, files with a NUL in the first 8000 bytes, and bytes past 20 MiB total
  are skipped and listed in `skipped`; regexes see at most 2000 chars per line; 50 findings per
  file, 500 per bundle. Patterns are linear (no nested quantifiers); a test feeds adversarial lines.
- Lines over 1000 chars in a script are flagged as obfuscation (minified or packed code).
- A bare long base64 blob is not flagged; only decode-and-exec, eval of decoded data, long hex or
  unicode escape runs, and very long lines are.
- Generic `key = "value"` secrets require a mixed letter/digit value that is not a placeholder.
- Secret test fixtures are assembled at runtime so no literal secrets live in the repo.
- Pipe-to-shell splits the line on single pipes: a download in any stage followed by a shell or
  interpreter (`sh`, `bash`, `python`, `perl`, ...) in a later stage is flagged.
- For KOBE-80: no severity ranking; any finding means "flagged", and flagged skills are always reviewed.
- Heuristic scanner: findings are review signals, not a verdict.

## Open questions (for Chris or the coordinator)

- none

## Evidence (acceptance criteria -> test or command output)

- ac-1: `packages/skill-scanner/src/scanner.test.ts`, positive and negative cases per category.
- ac-2: "clean bundles" tests assert no findings.
