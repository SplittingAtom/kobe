import { constants as FS } from "node:fs";
import { open, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * The two files in Pi's config dir that decide which model catalog and defaults Pi loads
 * (KOBE-169, closing KOBE-165): `models.json` (a `providers.kobe.models[]` entry with its own
 * `baseUrl` redirects the next `set_model`, and with it the session and run tokens) and
 * `settings.json`. Pi 1.0.0 never writes either under Kobe's launch flags (it writes only
 * `auth.json`, `models-store.json` and their locks, see PI_OWN_FILES), so the agent writes both
 * itself, near-empty, read-only, before Pi starts:
 *
 * - Under a Pi identity (KOBE-71) the files belong to the agent and `agent/` is sticky, so a tool
 *   (Pi's uid) can neither open them for writing nor rename or delete them to put its own in their
 *   place: kernel-enforced, so there is no check-then-read window to race.
 * - Without one the tool shares the agent's uid and can replace them; the content check
 *   ({@link tamperedConfig}) runs before and after every `pi.command` and before every prompt.
 *   Detection only; the boundary there is the paired uid (KOBE-167).
 */
export const GUARDED_CONFIG: Readonly<Record<string, string>> = {
  "models.json": '{"providers":{}}\n',
  "settings.json": "{}\n",
};

/** Write the guarded files (mode 0440 under an identity so its group reads them, else 0400). */
export async function writeGuardedConfig(agentDir: string, shared: boolean): Promise<void> {
  for (const [name, content] of Object.entries(GUARDED_CONFIG)) {
    await writeFile(path.join(agentDir, name), content, {
      mode: shared ? 0o440 : 0o400,
      flag: "wx",
    });
  }
}

/**
 * The guarded files that are not exactly what the agent wrote (missing, replaced by a link or
 * FIFO, or with other content), as `agent/<name>` strings. Opened without following links and
 * without blocking, then checked, as a tool can swap the file at any moment.
 */
export async function tamperedConfig(agentDir: string): Promise<string[]> {
  const bad: string[] = [];
  for (const [name, expected] of Object.entries(GUARDED_CONFIG)) {
    if ((await readGuarded(path.join(agentDir, name))) !== expected) bad.push(`agent/${name}`);
  }
  return bad;
}

async function readGuarded(file: string): Promise<string | null> {
  try {
    const handle = await open(file, FS.O_RDONLY | FS.O_NOFOLLOW | FS.O_NONBLOCK);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > 4096) return null;
      return await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}
