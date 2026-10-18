/**
 * Golden test vectors for the skill package hashes (KOBE-309): fixed file sets with their
 * runtime and package hashes. Any implementation of the canonical zip (the server's repack, a
 * CLI, the git mirror) must reproduce these exact hashes, in every timezone. Changing a value here
 * changes every skill's identity: never edit one, add a new contract instead.
 */
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

export interface SkillHashVector {
  readonly name: string;
  readonly files: ReadonlyMap<string, Uint8Array>;
  readonly runtimeHash: string;
  readonly packageHash: string;
}

const SKILL_MD = utf8(
  "---\nname: quarterly-report\ndescription: Builds the workbook\n---\nUse tables.\n",
);
const PAYLOAD: readonly [string, Uint8Array][] = [
  ["SKILL.md", SKILL_MD],
  ["scripts/build.py", utf8("print('totals')\n")],
  ["references/style.md", utf8("# Style\n")],
  ["assets/logo.bin", Uint8Array.from({ length: 256 }, (_, i) => i)],
];
const PACKAGE_EXTRAS: readonly [string, Uint8Array][] = [
  ["evals/cases.yaml", utf8("cases:\n  - id: q3\n    prompt: Build Q3\n")],
  ["evals/fixtures/sales.csv", utf8("region,total\nnorth,10\n")],
  [
    "kobe.skill.yaml",
    utf8(
      "apiVersion: kobe.dev/skill/v1\nname: quarterly-report\nversion: 1.3.0\nsummary: Builds the workbook.\n",
    ),
  ],
];
const PROVENANCE: [string, Uint8Array] = ["provenance.json", utf8('{"apiVersion":"x"}')];

const PAYLOAD_RUNTIME = "be87ed38fa36190f2fae79065587aeee6914eed5a2275ca5db7659ffca433fc1";

export const SKILL_HASH_VECTORS: readonly SkillHashVector[] = [
  {
    name: "a bare SKILL.md (what a text/markdown upload becomes)",
    files: new Map([
      ["SKILL.md", utf8("---\nname: notes\ndescription: Takes notes\n---\nBe brief.\n")],
    ]),
    runtimeHash: "c6c508059ef29568476c7105f777cc1f8fa26d23bf729d3777dd388837e2a140",
    packageHash: "c6c508059ef29568476c7105f777cc1f8fa26d23bf729d3777dd388837e2a140",
  },
  {
    name: "a payload with scripts/, references/ and a binary asset",
    files: new Map(PAYLOAD),
    runtimeHash: PAYLOAD_RUNTIME,
    packageHash: PAYLOAD_RUNTIME,
  },
  {
    name: "the same payload as a full package (evals/, kobe.skill.yaml, provenance.json)",
    files: new Map([...PAYLOAD, ...PACKAGE_EXTRAS, PROVENANCE]),
    runtimeHash: PAYLOAD_RUNTIME,
    packageHash: "918647c1b383b9f4c2b191b1f84774829dd8b9a9685b27a470974f00a62a8d37",
  },
  {
    name: "the full package with a different provenance.json (neither hash moves)",
    files: new Map([...PAYLOAD, ...PACKAGE_EXTRAS, ["provenance.json", utf8("{}")]]),
    runtimeHash: PAYLOAD_RUNTIME,
    packageHash: "918647c1b383b9f4c2b191b1f84774829dd8b9a9685b27a470974f00a62a8d37",
  },
  {
    name: "ordering: array-index names first, then UTF-16 order; UTF-8 names; an empty file",
    files: new Map([
      ["SKILL.md", SKILL_MD],
      ["a", utf8("a")],
      ["B", utf8("B")],
      ["10", utf8("ten")],
      ["9", utf8("nine")],
      ["é.md", utf8("accent")],
      ["😀.txt", utf8("emoji")],
      ["z/1", utf8("nested index")],
      ["scripts/evals/x.txt", utf8("payload, not evals")],
      [".keep", new Uint8Array(0)],
    ]),
    runtimeHash: "ff7ffecdc6a6b71ca904042523324b54b38db200b023eab8505bd2b43731c21b",
    packageHash: "ff7ffecdc6a6b71ca904042523324b54b38db200b023eab8505bd2b43731c21b",
  },
];
