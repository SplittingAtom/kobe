import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { unzipSync } from "fflate";
import { KOBE_SKILL_NAMES } from "@kobe/protocol";
import { KOBE_SKILL_NAMES as DB_KOBE_SKILL_NAMES } from "@kobe/db";
import { describe, expect, it } from "vitest";
import { KobePackageError, loadKobePackages, readKobePackage } from "./kobe-packages.js";
import { compareSemver } from "./semver.js";
import { sha256Hex } from "./storage.js";

/**
 * Every Kobe skill version ever published, by name and semver, with its bytes (KOBE-317, review
 * S5). **Append only: never edit or remove a line.** A Site that holds a version refuses other
 * bytes under it (kobe-seed.ts `version_reused`), so changing a published version's files would
 * leave Sites with different content under one name@semver. To change a skill: raise `version`
 * in its kobe.skill.yaml and add a line here; the newest line must be what ships.
 */
const PUBLISHED: Record<string, Record<string, { runtime: string; package: string }>> = {
  "data-analysis": {
    "1.0.0": {
      runtime: "ca616d138484673b4e44d30b80fefbad6054ddd502d9d9903e3ddaf1a30364cb",
      package: "d996440a667e8af726f13b0cca72ecab611e1a020cfc6feefe171f95587746e3",
    },
  },
  charts: {
    "1.0.0": {
      runtime: "6763bc70d0c5520684484b65a4c79fad26d72f14b5cb54ef8de98e978837198f",
      package: "75253531719219817620ef28dad9bd1b59525efb9fd2a74cca2488ee83f73310",
    },
  },
  docx: {
    "1.0.0": {
      runtime: "b778622cc009f1a871aea325e14cbc5cf25ca3a2b99638d0806f648a33490b53",
      package: "e9be33a6714640c488bd77ea170fdff3a0c430c26a6b8008e08187c039b66b5f",
    },
  },
  pdf: {
    "1.0.0": {
      runtime: "c9f0565f3b800856bccfa222a2634f84978d7b61bddcc6948be5a328f5823628",
      package: "7fcb96529d9e5acdcdd274da9ca6a1c0493f41d0f93a521005661d5978df5b62",
    },
  },
  xlsx: {
    "1.0.0": {
      runtime: "223e931984da44638277a682948c5602a35f9406b7f7d97751bcce5f3ed56a32",
      package: "cb090f9141f04e088b680dfd2aaae17211831bccde5b54a63b3903c315450f69",
    },
  },
  "code-review": {
    "1.0.0": {
      runtime: "1dafd860ab601ec3de3076ee33824896fea60914e00384f5195b86ad8d5d4f81",
      package: "4e5d9fd34c09b6b76601c3c635b985b7cf5881bd22b9283b2ed2162144f72753",
    },
  },
  "skill-creator": {
    "1.0.0": {
      runtime: "edc6a1a909b6b85801a48a4f9fbd305e8c4c1044915d3353ba93f1450aafd7ec",
      package: "05b240a4aa419c924a3be770f1952ec83a6731e5c072e19f251cf2059dae5aa6",
    },
  },
};

describe("the Kobe package set (KOBE-317)", () => {
  it("holds exactly the seven former built-ins, each named like its directory", async () => {
    const set = await loadKobePackages();
    expect(set.map((p) => p.name)).toEqual([...KOBE_SKILL_NAMES]);
    expect([...DB_KOBE_SKILL_NAMES]).toEqual([...KOBE_SKILL_NAMES]);
    for (const p of set) {
      expect(p.manifest).toMatchObject({ name: p.name, license: "Apache-2.0" });
      expect(p.bundle.description.length).toBeGreaterThan(0);
    }
  });

  it("sends sandboxes the skill's own files, without the manifest: the built-in's content", async () => {
    for (const p of await loadKobePackages()) {
      const runtime = Object.keys(unzipSync(p.bundle.zip));
      expect(runtime).toContain("SKILL.md");
      expect(runtime).not.toContain("kobe.skill.yaml");
      expect(Object.keys(unzipSync(p.bundle.packageZip ?? new Uint8Array()))).toContain(
        "kobe.skill.yaml",
      );
    }
  });

  it("ships the newest published version of each skill, with that version's bytes", async () => {
    for (const p of await loadKobePackages()) {
      const versions = PUBLISHED[p.name] ?? {};
      const newest = Object.keys(versions).sort(compareSemver).at(-1);
      expect(p.semver, `${p.name}: ship the newest line, or add a line for ${p.semver}`).toBe(
        newest,
      );
      expect(
        { runtime: sha256Hex(p.bundle.zip), package: p.bundle.packageHash },
        `${p.name}@${p.semver} changed its bytes: raise its version instead`,
      ).toEqual(versions[p.semver]);
    }
  });

  it("refuses a missing manifest, a renamed skill, a symlink and a stray directory", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "kobe-packages-"));
    try {
      const skill = (name: string, md: string, manifest?: string) =>
        mkdir(path.join(dir, name), { recursive: true }).then(async () => {
          await writeFile(path.join(dir, name, "SKILL.md"), md);
          if (manifest) await writeFile(path.join(dir, name, "kobe.skill.yaml"), manifest);
        });
      const md = (name: string) => `---\nname: ${name}\ndescription: "d"\n---\n# x\n`;
      const yaml = (name: string) =>
        `apiVersion: kobe.dev/skill/v1\nname: ${name}\nversion: 1.0.0\nsummary: s\n`;
      await skill("pdf", md("pdf"));
      await expect(readKobePackage(dir, "pdf")).rejects.toThrow(/kobe.skill.yaml is missing/);
      await skill("xlsx", md("other"), yaml("other"));
      await expect(readKobePackage(dir, "xlsx")).rejects.toThrow(/names other/);
      await skill("docx", md("docx"), yaml("docx"));
      await symlink("/etc/passwd", path.join(dir, "docx", "link"));
      await expect(readKobePackage(dir, "docx")).rejects.toThrow(KobePackageError);
      await expect(loadKobePackages(dir)).rejects.toThrow(/expected/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
