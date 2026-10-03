import { mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseModelFile } from "../kobe-models/protocol.js";
import { ModelFile } from "./model-file.js";

const RUN = "3e4f5a6b-7c8d-4e9f-8a1b-2c3d4e5f6072";
let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("ModelFile (agent side)", () => {
  it("writes a file the extension parses, private to the user, with no temp file left", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "kobe-model-file-"));
    const file = new ModelFile(path.join(dir, "model.json"), {
      gatewayUrl: "http://model-gateway.kobe.internal:80",
      model: { gatewayModel: "openai/gpt-fake", api: "openai-completions" },
      token: "t".repeat(40),
      runId: null,
    });
    await file.create();
    const parsed = parseModelFile(await readFile(file.path, "utf8"));
    expect(parsed).toEqual({
      v: 1,
      gateway_url: "http://model-gateway.kobe.internal:80",
      model: { gateway_model: "openai/gpt-fake", api: "openai-completions" },
      token: "t".repeat(40),
      run_id: null,
    });
    expect((await stat(file.path)).mode & 0o777).toBe(0o600);
    expect(await readdir(dir)).toEqual(["model.json"]);
  });

  it("updates run id, token and model in order, and skips no-op updates", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "kobe-model-file-"));
    const file = new ModelFile(path.join(dir, "model.json"), {
      gatewayUrl: "http://gw",
      model: null,
      token: "t".repeat(40),
      runId: null,
    });
    await file.create();
    const writes = [
      file.update({ runId: RUN, model: { gatewayModel: "a/b", api: "anthropic-messages" } }),
      file.update({ token: "u".repeat(40) }),
      file.update({ runId: null }),
    ];
    await Promise.all(writes);
    expect(parseModelFile(await readFile(file.path, "utf8"))).toMatchObject({
      model: { gateway_model: "a/b", api: "anthropic-messages" },
      token: "u".repeat(40),
      run_id: null,
    });
    const before = await stat(file.path);
    await new Promise((r) => setTimeout(r, 20));
    await file.update({ token: "u".repeat(40) });
    expect((await stat(file.path)).mtimeMs).toBe(before.mtimeMs);
  });

  it("rewrites after a failed write even for an identical update (nothing stays stale)", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "kobe-model-file-"));
    const file = new ModelFile(path.join(dir, "missing", "model.json"), {
      gatewayUrl: "http://gw",
      model: null,
      token: "t".repeat(40),
      runId: null,
    });
    await expect(file.create()).rejects.toThrow();
    await expect(file.update({ token: "u".repeat(40) })).rejects.toThrow();
    await mkdir(path.join(dir, "missing"));
    await file.update({ token: "u".repeat(40) });
    expect(parseModelFile(await readFile(file.path, "utf8")).token).toBe("u".repeat(40));
  });
});
