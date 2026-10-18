# Skill package contract

The files of one skill version as promotion, the Skills Registry, export and the git mirror carry
them (KOBE-309; spec Kobe v1.2 Skills System, SK14, SK19, SK29). The code is the contract:
`packages/protocol/src/skill-package/` (layout, canonical zip, `kobe.skill.yaml`,
`provenance.json`) and `@kobe/protocol/node` (`runtimeHash`, `packageHash`). Golden vectors:
`@kobe/protocol/testing` `SKILL_HASH_VECTORS`; golden fixtures:
`packages/protocol/src/skill-package/fixtures/`.

## Layout

```text
SKILL.md                 required; portable skill (Agent Skills format)   runtime payload
scripts/ references/ assets/ (any other path too)                         runtime payload
evals/cases.yaml         eval suite (KOBE-324), evals/fixtures/           package only
kobe.skill.yaml          author-edited registry metadata                  package only
provenance.json          Kobe-generated at promotion                      in neither hash
```

Only these root names are reserved: `scripts/evals/x` is payload. `checkPackagePaths` is the
validator, and the zip and hash functions run it themselves (no unchecked entry point; they throw
`SkillPackageError`):

- **Paths:** relative, `/`-separated, well-formed Unicode (lone surrogates are refused: two of
  them encode to the same UTF-8 name), NFC (refused otherwise, never normalized), at most 240
  UTF-8 bytes (so depth is bounded too), without empty, `.`, `..` or `__proto__` segments, C0/C1
  controls, backslashes, zero-width or bidi controls, a leading `/` or a drive letter.
- **Collisions:** two paths equal under case folding (`toUpperCase().toLowerCase()`) are refused,
  and so is a path that is both a file and a directory (`scripts` and `scripts/x`): no
  filesystem or git tree holds both. Directories are implied, never entries.
- **Reserved names are exact:** a root name that is a case variant of one (`Evals/`,
  `KOBE.SKILL.YAML`, `Provenance.json`, `skill.md`) is **refused**, not treated as payload or as
  reserved. A file named `evals` is refused.
- **`provenance.json` is Kobe's:** authored content (uploads, drafts, imports, built-ins) never
  carries one; it is refused unless Kobe assembled the package (`{ kobeProvenance: true }`).
- **Files only:** symlinks are refused at the source (a git mode 120000 entry is refused, never
  stored as its target text); file modes are not part of a package (the sandbox writes 0644, so
  scripts run through an interpreter); bytes are raw, with no line-ending normalization (a git
  mirror writes `* -text` in `.gitattributes`, so a CRLF checkout can't re-import under another
  hash).

## Hashes

Both are lowercase hex SHA-256 of a **canonical zip**:

| Hash         | Covers                                                                | Used for                                                                                               |
| ------------ | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Runtime hash | the payload: all but `evals/**`, `kobe.skill.yaml`, `provenance.json` | identity everywhere: `content_hash`, blocklist, resolver, materialization, the sandbox's `--skill` dir |
| Package hash | all but `provenance.json`                                             | `package_hash`, Registry versions, scorecard freshness (SK20), package zips                            |

`provenance.json` records both hashes, so neither covers it. For a skill without `evals/` and
`kobe.skill.yaml`, the two hashes are equal.

### Identity: one hash per payload

**The identity of a skill version is the hash of the zip its sandboxes receive.** Blocklist,
resolver, materialization, promotion and imports all use that one hash, and from KOBE-310 on it is
always the runtime hash: Kobe stores the runtime zip for the sandbox and `content_hash =
runtimeHash`. The resolver and the Pi `--skill` directory are unchanged.

Before KOBE-310 the server hashes the whole upload. For a bundle without the reserved root names
(every bundle seen so far is expected to be one) the stored `content_hash` already is its runtime
hash (the server test in `services/server/src/skills/package-hash.test.ts` proves the bytes are
equal). A stored bundle that does hold `evals/`, `kobe.skill.yaml` or `provenance.json` at its
root has a `content_hash` that is **not** its runtime hash, and its sandboxes receive those files
today. KOBE-310 must therefore:

1. Recompute the runtime hash of every stored version from its zip (a one-off on upgrade), and
   report how many differ.
2. For each that differs, record the runtime hash beside the stored one (an alias of the same
   version) and treat the two as one identity: blocking either blocks both, and `isBlocked`
   matches both. The stored row and its bytes are never rewritten.
3. Store new uploads, saves and promotions as runtime zips, so no new version gets a second
   hash.

### Canonical zip

The bytes the server's repack has always written (fflate `zipSync`, stored), now specified so any
tool can reproduce them:

- Entries in order: names that are JavaScript array indices (`0`, `9`, `10`, `4294967294`; not
  `01`, `-1` or `4294967295`; only root names without a dot or slash can be one) first, in numeric
  order; then all other names compared as **UTF-16 code units: NOT code points and NOT UTF-8
  bytes**. They differ for U+E000..U+FFFF against characters above U+FFFF: `😀.txt` (U+1F600, first
  unit 0xD83D) sorts before `～.txt` (U+FF5E), although its code point and its bytes are larger.
  Go's `sort.Strings`, Python's `sorted` and `git ls-tree` order by bytes or code points, so an
  implementation in those languages must compare UTF-16 units explicitly; the last golden vector
  fails otherwise. (Both rules are what the KOBE-78 repack wrote, kept so existing hashes stay
  valid: fflate takes an object, whose index keys enumerate first, and JavaScript sorts by UTF-16.)
- Each entry: local file header (version needed 20, method 0 stored, DOS time 0x6000 = 12:00:00,
  date 0x5021 = 2020-01-01, CRC-32, size twice, no extra field), the UTF-8 name, the bytes.
  General-purpose flags 0x0800 when the name has a non-ASCII character, else 0.
- Then the central directory in the same order (version made by 20, MS-DOS; the same fields; no
  comment; disk 0; internal and external attributes 0; local header offset), then the end record
  (no comment). No directory entries, extra fields, data descriptors, encryption or zip64.
- Nothing depends on the clock, the timezone, file modes or the tool's compression.

## kobe.skill.yaml

UTF-8, at most 16 KiB, one YAML 1.2 (core schema) document whose root is a mapping; duplicate
keys and aliases are refused (`MANIFEST_YAML_OPTIONS` for eemeli/yaml). Unknown keys are refused.

| Key                                  | Rule                                                                                 |
| ------------------------------------ | ------------------------------------------------------------------------------------ |
| `apiVersion`                         | `kobe.dev/skill/v1`                                                                  |
| `name`                               | skill name pattern; must equal the SKILL.md frontmatter `name`                       |
| `version`                            | MAJOR.MINOR.PATCH (9 digits a part, no pre-release); must equal the saved semver     |
| `summary`                            | 1–280 characters (UTF-16 code units, as everywhere in this contract)                 |
| `tags`                               | ≤ 10 unique topic slugs (unknown ones are proposals)                                 |
| `license`                            | SPDX expression or `Proprietary`; required at submission (SK20), not in a draft      |
| `maintainers`                        | ≤ 20 unique `user:<uuid>`; a request: Kobe sets maintainers on approval (SK24)       |
| `capabilities.egress`                | ≤ 50 exact lowercase hosts (no wildcard, no port), checked against the team's egress |
| `capabilities.packages.pip` / `.npm` | ≤ 50 requirement strings each, no whitespace                                         |
| `compatibility.kobe` / `.pi`         | short version ranges, informational                                                  |
| `changelog`                          | 1–1024 characters                                                                    |

Nothing in it grants anything: capabilities and any frontmatter never pre-approve tools.

## provenance.json

Kobe writes it at promotion as canonical JSON (RFC 8785), at most 256 KiB; never author-edited.
**It is unsigned and informational:** anyone who handles an exported or mirrored package can edit
it without changing a hash. Kobe never reads one back as fact: an incoming `provenance.json`
(upload, draft, zip or git import) is refused (`checkPackagePaths`), and Kobe writes its own from
its records on every export. Its fields are of three kinds:

| Kind                                                    | Fields                                                                        |
| ------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Verifiable against the package (`provenanceMismatches`) | `name`, `version`, `hashes`, `scorecard.packageHash` (freshness)              |
| Kobe-attested: authoritative only in Kobe's records     | `source`, `submitter`, `confirmedBy`, `scan`, the scorecard numbers, `origin` |
| Informational                                           | `fromConversation`, `createdAt`                                               |

`apiVersion: kobe.dev/skill-provenance/v1`, `name`, `version`, `hashes {runtime, package}`,
`source {scope, teamId, skillId, seq, semver}` (the source team, SK24), `submitter {userId, at}`,
optional `confirmedBy` (a Team admin confirming a Builder's request), `fromConversation`,
optional `origin {kind: git|zip, url, commit, fetchedSha256}` for governed imports (SK30), where
`url` is `https` with no credentials (userinfo), query or fragment, so no token reaches an export,
`scan {scanner {name, version, rulesVersion}, verdict: pass|caution|block, findings [{category,
rule, file, line}]}` (locations only, no excerpts), optional `scorecard` (numbers only:
`packageHash`, mode, case counts, pass rates, lift, trigger precision and recall, cost, `at`) and
`createdAt`. Instants are `toISOString()` UTC. No transcripts, prompts, answers or thread ids:
eval detail never leaves the team. `provenanceMismatches` checks it against the package beside
it; a scorecard from another package hash is stale.
