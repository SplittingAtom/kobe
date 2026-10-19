# Skill package contract

The files of one skill version as promotion, the Skills Registry, export and the git mirror carry
them (KOBE-309; spec Kobe v1.2 Skills System, SK14, SK19, SK29). The code is the contract:
`packages/protocol/src/skill-package/` (layout, canonical zip, `kobe.skill.yaml`,
`provenance.json`) and `@kobe/protocol/node` (`runtimeHash`, `packageHash`). Golden vectors:
`@kobe/protocol/testing` `SKILL_HASH_VECTORS`; golden fixtures:
`packages/protocol/src/skill-package/fixtures/`.

## Layout

The eval suite's own format is in [skill-evals.md](skill-evals.md).

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
the stored `content_hash` already is its runtime hash (the server test in
`services/server/src/skills/package-hash.test.ts` proves the bytes are equal). Two kinds of stored
bundle are different: one that holds `evals/` or `kobe.skill.yaml` at its root has a
`content_hash` that is **not** its runtime hash (its sandboxes receive those files today), and one
that today's path rules refuse (a root `provenance.json`, invisible or bidi characters, a
file/folder clash, a case variant such as `Evals/`) has no runtime hash at all. KOBE-310 therefore:

1. **Stops making them.** The upload path applies `checkPackagePaths` (authored content: no
   `provenance.json`) before anything is stored, and stores new uploads, saves and promotions as
   runtime zips, so `content_hash = runtimeHash` for every new version.
2. **Recomputes every stored hash once** (on upgrade, in the background), from the stored zip:
   - valid under today's rules and equal: nothing to do;
   - valid but different (`evals/`, `kobe.skill.yaml`): an **alias** from the stored hash to the
     runtime hash;
   - refused by today's rules: **legacy**. Its stored hash stays its only identity (no alias);
     it keeps running exactly as before, but is never promotable or exportable until re-saved,
     and the re-save goes through today's rules and gets a runtime hash. (A root
     `provenance.json` is legacy, never hashed with `kobeProvenance`.)
   - a stored `kobe.skill.yaml` (never read before KOBE-310) that is invalid or names another
     skill, or an invalid SKILL.md, also makes it legacy.

   Every checked hash is recorded with its outcome, so the recompute is **idempotent and
   re-runnable**: a later run skips what is recorded and checks only what is new. It runs at
   start and every 10 minutes, one replica at a time (a Postgres advisory lock), so versions a
   pod of the previous release writes during a rolling upgrade or after a rollback are picked up
   too. It reports how many hashes were aliased and how many are legacy. The stored rows and
   bytes are never rewritten, and a recorded outcome is never re-evaluated: a later tightening of
   the rules applies to new uploads only. Export (and so promotion) never treats an unchecked
   hash as clean: it checks one on demand first, and refuses a version whose manifest names
   another version than its own.

3. **Records the package hash too.** When a new version's package zip differs from its runtime
   zip, its package hash is recorded as an alias of the runtime hash, so blocking the hash of a
   downloaded package (downloads serve the package) blocks the skill.
4. **Treats an alias group as one identity.** The alias map is site-wide, and many stored hashes
   can share one runtime hash (the same payload uploaded with different `evals/`, in one team or
   several). A hash's group is its runtime hash plus every stored hash aliased to it (a legacy
   hash is a group of one). The blocklist works on groups: a hash is blocked when any member of
   its group is listed, adding a hash whose group is already blocked is a no-op, and removing one
   unblocks the whole group (every listed member is removed).

### Canonical zip

The bytes the server's repack has always written (fflate `zipSync`, stored), now specified so any
tool can reproduce them:

- Entries in order: first the **numeric names**, then all others.
  - A name is numeric when it matches `^(0|[1-9][0-9]*)$` (ASCII digits, no leading zero) and its
    value is at most 4294967294 (2³²−2). So `0`, `9`, `10` and `4294967294` are numeric; `01`,
    `-1`, `1.5` and `4294967295` are not. Only root names can be numeric (a `/` is not a digit).
    Numeric names are ordered by value.
  - All other names are ordered lexicographically over the full path, comparing **UTF-16 code
    units: NOT code points and NOT UTF-8 bytes**; a proper prefix sorts first. The two differ for
    U+E000..U+FFFF against characters above U+FFFF: `😀.txt` (U+1F600, first unit 0xD83D) sorts
    before `～.txt` (U+FF5E), although its code point and its bytes are larger. Go's
    `sort.Strings`, Python's `sorted` and `git ls-tree` order by bytes or code points, so an
    implementation in those languages must compare UTF-16 units explicitly; the last golden
    vector fails otherwise.
  - Both rules are what the KOBE-78 repack wrote, kept so existing hashes stay valid: fflate
    takes an object, whose array-index keys (exactly the numeric names) enumerate first, and
    JavaScript sorts strings by UTF-16 code units.
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
rule, file, line}]}` (locations only, no excerpts), optional `scorecard`: a `CatalogSkillEvalScorecard`
([skill-evals.md](skill-evals.md), numbers only, `full` runs only: `packageHash`, case and status
counts, pass rates, lift or why it is missing, trigger precision and recall when defined with their
counts, cost, judge source, run-model fallback, `at`) and
`createdAt`. Instants are `toISOString()` UTC. No transcripts, prompts, answers or thread ids:
eval detail never leaves the team. `provenanceMismatches` checks it against the package beside
it; a scorecard from another package hash is stale.

### Kobe-published versions

Kobe's own catalog skills (KOBE-317, SK4: the former built-ins) are published by the server
itself from the package set it ships (`services/server/builtin-skills/<name>/`, each with a
`kobe.skill.yaml` whose `version` is the catalog semver). Nobody promotes them, so their
provenance (stored with the version) has `publisher: "kobe"` instead of `source`, `submitter`,
`confirmedBy`, `origin` and `scorecard`; the rest is as above. Their versions only rise: changing a
skill's files means raising its `version` (`kobe-packages.test.ts` holds each version's hashes),
and a Site refuses new bytes under a semver it holds or below its newest.

## Scan limits

The scanner (`@kobe/skill-scanner`) reads every text file of the package, `evals/` and
`kobe.skill.yaml` included, up to the upload's per-file limit (10 MiB): no file an upload accepts
is refused or blocked for its size alone. A server test ties the two limits together. The scanner
reads at most 20 MiB of text per package. A package with more text than that (the upload allows
25 MiB uncompressed) gets one Block finding, `scan-incomplete`, so bulk never buys a Pass. A file
over the per-file cap (which upload refuses anyway) is Block `oversized-file`. Long lines are read
in overlapping windows. Block findings are never dropped by the 500-finding cap, and a cut adds
`findings-truncated`.
