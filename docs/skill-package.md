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

Only these root names are reserved: `scripts/evals/x` is payload. Paths are relative,
`/`-separated, NFC, at most 240 UTF-8 bytes, without empty, `.`, `..` or `__proto__` segments,
control characters, backslashes, a leading `/` or a drive letter. Two paths that differ only by
case are refused, and so is a file named `evals`. Directories are implied, never entries.

## Hashes

Both are lowercase hex SHA-256 of a **canonical zip**:

| Hash         | Covers                                                                | Used for                                                                                               |
| ------------ | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Runtime hash | the payload: all but `evals/**`, `kobe.skill.yaml`, `provenance.json` | identity everywhere: `content_hash`, blocklist, resolver, materialization, the sandbox's `--skill` dir |
| Package hash | all but `provenance.json`                                             | `package_hash`, Registry versions, scorecard freshness (SK20), package zips                            |

`provenance.json` records both hashes, so neither covers it. For a skill without `evals/` and
`kobe.skill.yaml`, the two hashes are equal, and the runtime hash is the `content_hash` Kobe has
stored since KOBE-78: no stored hash changes, and the resolver and the Pi `--skill` directory
are unchanged.

### Canonical zip

The bytes the server's repack has always written (fflate `zipSync`, stored), now specified so any
tool can reproduce them:

- Entries in order: names that are JavaScript array indices (`0`, `9`, `10`, at most 2³²−2: only
  root names without a dot or slash) first, in numeric order; then all other names by UTF-16 code
  units. (The first rule is a legacy of fflate taking an object; it keeps existing hashes valid.)
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
| `summary`                            | 1–280 characters                                                                     |
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
`apiVersion: kobe.dev/skill-provenance/v1`, `name`, `version`, `hashes {runtime, package}`,
`source {scope, teamId, skillId, seq, semver}` (the source team, SK24), `submitter {userId, at}`,
optional `confirmedBy` (a Team admin confirming a Builder's request), `fromConversation`,
optional `origin {kind: git|zip, url (https), commit, fetchedSha256}` for governed imports (SK30),
`scan {scanner {name, version, rulesVersion}, verdict: pass|caution|block, findings [{category,
rule, file, line}]}` (locations only, no excerpts), optional `scorecard` (numbers only:
`packageHash`, mode, case counts, pass rates, lift, trigger precision and recall, cost, `at`) and
`createdAt`. Instants are `toISOString()` UTC. No transcripts, prompts, answers or thread ids:
eval detail never leaves the team. `provenanceMismatches` checks it against the package beside
it; a scorecard from another package hash is stale.
