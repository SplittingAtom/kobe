import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MODEL_FILE_ENV } from "./protocol.js";
import { readModelState, takeModelFilePath } from "./state-file.js";

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("model file access", () => {
  it("takes the file path from the environment and removes it (tools never see it)", () => {
    const env: Record<string, string | undefined> = { [MODEL_FILE_ENV]: "/run/m.json", X: "1" };
    expect(takeModelFilePath(env)).toBe("/run/m.json");
    expect(env).toEqual({ X: "1" });
    expect(takeModelFilePath({ [MODEL_FILE_ENV]: "relative/m.json" })).toBeUndefined();
    expect(takeModelFilePath({})).toBeUndefined();
  });

  it("reads the file the agent wrote and reports unreadable or invalid files", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "kobe-models-"));
    const file = path.join(dir, "model.json");
    await writeFile(
      file,
      JSON.stringify({
        v: 1,
        gateway_url: "http://gw",
        model: { gateway_model: "openai/m", api: "openai-completions" },
        token: "t".repeat(40),
        run_id: null,
      }),
    );
    expect((await readModelState(file)).model?.gateway_model).toBe("openai/m");
    await expect(readModelState(path.join(dir, "missing.json"))).rejects.toThrow(/cannot read/);
    await writeFile(file, "{}");
    await expect(readModelState(file)).rejects.toThrow(/version/);
  });
});
