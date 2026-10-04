import { chmod, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { piVersion } from "./version.js";

describe("piVersion", () => {
  it("reads Pi's version from the package behind the `pi` symlink, without running it", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-version-"));
    const pkg = join(root, "node_modules/@earendil-works/pi-coding-agent");
    await mkdir(join(pkg, "dist/bundle"), { recursive: true });
    await writeFile(
      join(pkg, "package.json"),
      JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "1.0.3" }),
    );
    // A script that would report another version if it were run.
    const cli = join(pkg, "dist/bundle/cli.js");
    await writeFile(cli, "#!/bin/sh\necho 9.9.9\n");
    await chmod(cli, 0o755);
    const bin = join(root, "bin");
    await mkdir(bin);
    await symlink(cli, join(bin, "pi"));
    await expect(piVersion("pi", { PATH: bin })).resolves.toBe("1.0.3");
  });

  it("falls back to `pi --version` when there is no Pi package", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-version-"));
    const cli = join(root, "pi");
    await writeFile(cli, "#!/bin/sh\necho 'pi 1.0.0'\n");
    await chmod(cli, 0o755);
    await expect(piVersion("pi", { PATH: root })).resolves.toBe("1.0.0");
  });
});
