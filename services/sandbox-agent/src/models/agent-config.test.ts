import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tamperedConfig, writeGuardedConfig } from "./agent-config.js";

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});
const fresh = async () => (dir = await mkdtemp(path.join(tmpdir(), "kobe-agentcfg-")));

describe("guarded Pi config (KOBE-169)", () => {
  it("writes read-only files and reports nothing for them", async () => {
    const agent = await fresh();
    await writeGuardedConfig(agent, false);
    expect(await tamperedConfig(agent)).toEqual([]);
    await expect(writeFile(path.join(agent, "models.json"), "{}")).rejects.toThrow(/EACCES/);
  });

  it("reports changed, replaced, linked and missing files", async () => {
    const agent = await fresh();
    await writeGuardedConfig(agent, false);
    await chmod(path.join(agent, "models.json"), 0o600);
    await writeFile(path.join(agent, "models.json"), '{"providers":{"kobe":{"models":[]}}}');
    await rm(path.join(agent, "settings.json"));
    expect(await tamperedConfig(agent)).toEqual(["agent/models.json", "agent/settings.json"]);
    await symlink(path.join(agent, "models.json"), path.join(agent, "settings.json"));
    expect(await tamperedConfig(agent)).toEqual(["agent/models.json", "agent/settings.json"]);
    expect(await readFile(path.join(agent, "models.json"), "utf8")).toContain("kobe");
  });
});
