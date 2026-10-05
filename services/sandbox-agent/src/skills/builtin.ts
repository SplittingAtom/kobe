import { stat } from "node:fs/promises";
import path from "node:path";
import { isBuiltinSkillName } from "@kobe/protocol";
import { SkillError } from "./store.js";

/**
 * Built-in skills (KOBE-88): the gallery skills baked read-only into the image under
 * `<dir>/<name>/` (root-owned, so neither the agent, Pi nor a tool can change them). Nothing is
 * fetched or copied: a run registers exactly the built-ins `run.start.config.builtin_skills` lists.
 * The directory comes from the image's own `KOBE_BUILTIN_SKILLS_DIR`, never from a frame, and the
 * names are checked against the protocol's fixed list, so a frame cannot point Pi anywhere else.
 */
export async function builtinSkillDirs(
  dir: string,
  names: readonly string[],
): Promise<readonly string[]> {
  const dirs: string[] = [];
  for (const name of new Set(names)) {
    if (!isBuiltinSkillName(name)) throw new SkillError(`unknown built-in skill ${name}`);
    const skillDir = path.join(dir, name);
    const manifest = await stat(path.join(skillDir, "SKILL.md")).catch(() => undefined);
    if (manifest === undefined || !manifest.isFile()) {
      throw new SkillError(`built-in skill ${name} is not installed in this image`);
    }
    dirs.push(skillDir);
  }
  return dirs;
}
