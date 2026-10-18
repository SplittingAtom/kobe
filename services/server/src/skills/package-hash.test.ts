import { zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import { runtimeFiles } from "@kobe/protocol";
import { runtimeHash, runtimeZip } from "@kobe/protocol/node";
import { SKILL_HASH_VECTORS } from "@kobe/protocol/testing";
import { bundleFromSkillMd, validateZipBundle } from "./bundle.js";
import { sha256Hex } from "./storage.js";

/**
 * KOBE-309 ac-2/ac-4: the contract's runtime hash is the `content_hash` the server has stored since
 * KOBE-78. An upload of a vector's runtime payload, however it was zipped (deflated, shuffled,
 * inside a wrapper folder) and in whatever timezone, is repacked to the contract's canonical zip,
 * so blocklist, resolver and materialization keep addressing skills by the same hash.
 */
const TIMEZONES = ["UTC", "Pacific/Kiritimati", "America/Los_Angeles", "Asia/Kolkata"];
const savedTz = process.env.TZ;
afterEach(() => {
  process.env.TZ = savedTz;
});

/** A zip as an arbitrary tool might write it: deflated, reversed, with a wrapper folder. */
function foreignZip(files: ReadonlyMap<string, Uint8Array>, wrapper: string | null): Uint8Array {
  const entries: Record<string, [Uint8Array, { level: 6; mtime: Date }]> = Object.create(null);
  for (const [path, bytes] of [...files].reverse())
    entries[wrapper ? `${wrapper}/${path}` : path] = [bytes, { level: 6, mtime: new Date() }];
  return zipSync(entries);
}

describe("runtime hash = stored content_hash (KOBE-309)", () => {
  for (const v of SKILL_HASH_VECTORS) {
    const payload = runtimeFiles(v.files);
    it(`repacks uploads of "${v.name}" to the contract's bytes in every timezone`, () => {
      for (const tz of TIMEZONES) {
        process.env.TZ = tz;
        for (const wrapper of [null, "my-skill"]) {
          const checked = validateZipBundle(foreignZip(payload, wrapper));
          if (!checked.ok) throw new Error(`${tz}: ${checked.error.code}`);
          expect(checked.value.zip).toEqual(runtimeZip(v.files, v.options));
          expect(sha256Hex(checked.value.zip), tz).toBe(v.runtimeHash);
        }
      }
    });
  }

  it("hashes a bare SKILL.md upload as its one-file runtime payload", () => {
    const v = SKILL_HASH_VECTORS[0];
    const md = v?.files.get("SKILL.md");
    if (!v || !md) throw new Error("vector missing");
    for (const tz of TIMEZONES) {
      process.env.TZ = tz;
      const wrapped = bundleFromSkillMd(md);
      if (!wrapped.ok) throw new Error(wrapped.error.code);
      expect(sha256Hex(wrapped.value.zip)).toBe(v.runtimeHash);
      expect(runtimeHash(v.files, v.options)).toBe(v.runtimeHash);
    }
  });
});
