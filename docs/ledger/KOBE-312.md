# KOBE-312: A6: Scanner verdict tiers, file-type allowlist and prose rules

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (group branch, Skills v1.2 Phase A)
- **Branch / worktree:** `group-skills-a` in `../Kobe-skA`
- **Depends on:** KOBE-307 (same branch). No migration.

## Decisions

- **Scanner (`packages/skill-scanner`):** every finding has a `severity` (`caution` | `block`);
  `ScanResult` gains `verdict` (worst severity, or `pass`) and `ruleSetVersion`
  (`RULE_SET_VERSION`, bump on any rule/severity/limit change). `verdictOf(findings)` also reads
  stored findings: no severity (stored before) counts as Caution, so existing flagged rows are
  Caution.
- **File-type allowlist (Block, `files.ts`):** nested archives by extension or magic (zip, gzip,
  bzip2, xz, 7z, rar, zstd, tar; wheels, jars, debs…), compiled code by extension (.pyc, .so,
  .dll, .class, .exe, .wasm…), executables by magic (ELF, PE, Mach-O, wasm), unknown binaries
  (NUL bytes, not an allowed asset), hidden files over 64 KiB. Allowed binary assets need their
  magic to match the extension (png, jpeg, gif, webp, pdf, ico, woff/woff2, ttf/otf, mp3, ogg,
  wav). Previously binaries were skipped silently; a blocked file is now a finding.
- **Prose rules (Caution, `prose.ts`)** on every text file, one per line: `prompt-injection`,
  `conceal-from-user`, `exfiltration-request`, `prerequisite-install`, and `invisible-unicode`
  (zero-width, bidi, soft hyphen, BOM except a leading one). Linear patterns with bounded gaps.
- **Whole tree:** every file is checked for its type, hidden files included; text rules on every
  text file within the existing size caps (script rules still need a script).
- **Review wiring (no migration):** the verdict is derived from a row's stored findings.
  Approving a Caution or Block scan needs `acknowledged: true` (422
  `acknowledgement_required`); a Block scan can be approved only by a caller whose site role has
  the new `site.skills.override_scan` (Site admin, Owner), with a note as the reason (409
  `scan_blocked` / 400), audited as `skill.scan.override` (team log; counts blocking findings).
  Rejecting is always allowed. `skill.reviewed` gains optional `verdict` and `acknowledged`.
  Review JSON gains `verdict`. Usability is unchanged: only approved rows run, so a Block version
  never runs without the override.
- **Web:** the review queue shows Caution / Blocked by scan badges; the existing confirm is the
  acknowledgement; a Block item has a reason box for the Site admin override.
- **ac-4:** `skills/no-preapproval.test.ts`: frontmatter (incl. `allowed-tools`) is stored only;
  a run's skill ref is strictly `{name, sha256, size}`; no server source reads `allowed-tools`.

- **Review fixes (B1, B2, S1–S7; rule set `2026.10.18.2`):**
  - B1: a text file over 1 MiB is Block `oversized-file`; past the 20 MiB budget one Block
    `scan-incomplete` (category `limit`). Long lines are read in overlapping windows.
  - B2: Block findings are never capped (they come first); any cut adds `findings-truncated`
    carrying the worst dropped tier.
  - S1: NUL test over the whole file; zip/ELF/PE/Mach-O headers at any offset are Block
    `embedded-binary` (polyglot assets, appended payloads); ar, lz4, compress always, and LZIP,
    cab, cpio, xar, squashfs only in binary content (they are printable); more extensions.
  - S2: scripts also by no extension, `scripts/`, invisible characters stripped from the extension,
    or a run reference elsewhere (`bash x.txt`, `./tool`); pipe-to-shell rules on every text file.
  - S3: Tag block, variation selectors (one after an emoji allowed), U+061C, Hangul fillers,
    U+180E, U+034F, U+2028/2029; ZWJ between emoji allowed; paths get `invisible-unicode-path`.
  - S4: approving an unscanned row is 409 `scan_pending`; late scans read the package zip.
  - S5: `storedVerdict` reads a stored scan with a `skipped` non-asset file and no finding as
    Caution (team review for personal versions); equals `verdict` for new scans.
  - S6: `skill.scan.override` adds the blocking `rules` and `reasonSha256` of the note.
  - S7: review JSON has `findingsDigest` (SHA-256 of stored findings + skipped); approving needs
    `acknowledgedFindings` equal to it (409 `findings_changed`); `acknowledged` is gone from the
    body; `skill.reviewed` records `findingsSha256`.

## Open questions (for Chris or the coordinator)

- Rescans on a rule-set change (SK32) need the rule-set version stored per scan (a column):
  KOBE-313. Until then S5's stopgap covers old binary rows; an ELF named `.png` in an old row
  still reads Pass until rescanned.
- Not done (nits): prose NFKC/paragraph matching (N1), the sandbox-agent no-preapproval grep (N4),
  the reason box only for Site admins (N5), uploader ≠ overrider (N3).
- The override must be done inside the team (team review route) by a Site admin who can act in
  it; a site-console override route can come with the Registry review (Phase C).

## Evidence (acceptance criteria → test or command output)

- ac-1/ac-2: `packages/skill-scanner/src/verdicts.test.ts` (each new rule, severity, verdict,
  rule set, stored-finding reading); `scanner.test.ts` updated.
- ac-3: `services/server/src/skill-review.db.test.ts` "scan verdict tiers in review" (Block needs a
  Site admin with a reason, audited; Caution needs acknowledgement; old rows read as Caution);
  `apps/web/components/admin/skill-review-pages.test.tsx`.
- ac-4: `services/server/src/skills/no-preapproval.test.ts`.
- Review fixes: `packages/skill-scanner/src/bypasses.test.ts` (one golden case per PoC);
  `skill-review.db.test.ts` "review gating holes"; the reviewer's `poc312/*.mjs` rerun.
