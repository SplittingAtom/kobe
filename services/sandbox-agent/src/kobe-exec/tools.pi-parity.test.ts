import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serveExecutor } from "../exec/executor/server.js";
import { PI_AVAILABLE } from "../testing/real-pi.js";
import { writeFakeSearchTools } from "../testing/fake-search-tools.js";
import { socketPair } from "../testing/socket-pair.js";
import { ExecClient } from "./client.js";
import { registerExecTools, TOOL_NAMES, type PiToolFactories, type ToolLike } from "./tools.js";

/**
 * Parity with Pi's own tools (KOBE-167): the same operation, run once by Pi 1.0.0's built-in tool
 * in this process and once by the routed tool through an executor, must give the same result (or
 * the same error message). Pi comes from the pinned install (images/sandbox/pi); skipped without.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PI_INDEX = path.resolve(
  HERE,
  "../../../../images/sandbox/pi/node_modules/@earendil-works/pi-coding-agent/dist/index.js",
);

type Params = Record<string, unknown>;
interface Result {
  content?: unknown;
  details?: unknown;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

let pi: PiToolFactories;
let root: string;
let work: string;
let local: Map<string, ToolLike>;
let routed: Map<string, ToolLike>;
let log: string;
let oldPath: string | undefined;
let closeAll: () => void;

function collect(factories: PiToolFactories, transport: ExecClient, cwd: string) {
  const tools = new Map<string, ToolLike>();
  registerExecTools(
    { registerTool: (tool) => void tools.set((tool as ToolLike).name, tool as ToolLike) },
    transport,
    factories,
    cwd,
  );
  return tools;
}

beforeAll(async () => {
  if (!PI_AVAILABLE) return;
  root = await mkdtemp(path.join(tmpdir(), "kobe-exec-parity-"));
  work = path.join(root, "work");
  await mkdir(work);
  const bin = await writeFakeSearchTools(root);
  log = path.join(root, "tools.log");
  oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath ?? ""}`;
  process.env.FAKE_TOOL_LOG = log;
  process.env.PI_OFFLINE = "1";
  pi = (await import(pathToFileURL(PI_INDEX).href)) as unknown as PiToolFactories;
  const [clientEnd, peer] = await socketPair();
  serveExecutor({ input: peer, output: peer, commandEnv: process.env });
  const client = new ExecClient(clientEnd);
  closeAll = () => {
    clientEnd.destroy();
    peer.destroy();
  };
  routed = collect(pi, client, work);
  // Pi's own definitions, built the way the agent builds them.
  local = new Map(
    TOOL_NAMES.map((name) => {
      const factory =
        `create${name[0]?.toUpperCase()}${name.slice(1)}ToolDefinition` as keyof PiToolFactories;
      return [name, (pi[factory] as (cwd: string) => ToolLike)(work)] as const;
    }),
  );
});

afterAll(async () => {
  if (!PI_AVAILABLE) return;
  closeAll();
  if (oldPath !== undefined) process.env.PATH = oldPath;
  delete process.env.FAKE_TOOL_LOG;
  await rm(root, { recursive: true, force: true });
});

/** What Pi hands a tool: the session and model it exposes to bash as PI_* variables. */
function toolContext(): never {
  return {
    cwd: work,
    model: { provider: "kobe", id: "m-1", input: ["text", "image"] },
    thinkingLevel: "off",
    sessionManager: { getSessionId: () => "session-1", getSessionFile: () => "/tmp/s.jsonl" },
  } as never;
}

/** The log of rg/fd invocations after the first `skip` lines, without Pi's `--version` probes. */
async function invocations(skip = 0): Promise<string[]> {
  const lines = (await readFile(log, "utf8")).split("\n").filter((l) => l !== "");
  return lines.filter((l) => !l.includes('["--version"]')).slice(skip);
}

/** What a tool call produced: the result, or the error message. Wall-clock fields are dropped. */
async function run(
  tools: Map<string, ToolLike>,
  name: string,
  params: Params,
  signal?: AbortSignal,
) {
  try {
    const result = (await (tools.get(name) as ToolLike).execute(
      "call",
      params as never,
      signal,
      undefined,
      toolContext(),
    )) as Result;
    const structured = result.structuredContent;
    if (structured !== undefined) delete structured.wall_time_seconds;
    return JSON.parse(JSON.stringify(result)) as unknown;
  } catch (error) {
    return { error: (error as Error).message };
  }
}

/** Run on both; they must agree, and (guarding against two identical failures) on error or not. */
async function same(name: string, params: Params, expectError = false): Promise<unknown> {
  const expected = await run(local, name, params);
  const actual = await run(routed, name, params);
  expect(actual).toEqual(expected);
  expect(typeof (actual as { error?: unknown }).error === "string", JSON.stringify(actual)).toBe(
    expectError,
  );
  return actual;
}

describe.skipIf(!PI_AVAILABLE)("the routed tools match Pi's own", () => {
  it("overrides exactly the seven built-in tools", () => {
    expect([...routed.keys()].sort()).toEqual([...TOOL_NAMES].sort());
    for (const name of TOOL_NAMES) {
      const a = local.get(name) as ToolLike;
      const b = routed.get(name) as ToolLike;
      for (const key of [
        "label",
        "description",
        "promptSnippet",
        "promptGuidelines",
        "renderShell",
      ]) {
        expect(b[key], `${name}.${key}`).toEqual(a[key]);
      }
      expect(JSON.stringify(b.parameters)).toBe(JSON.stringify(a.parameters));
    }
  });

  describe("bash", () => {
    it("gives the same output, exit status and error text", async () => {
      await same("bash", { command: "echo hello; echo oops >&2" });
      await same("bash", { command: "echo partial; exit 7" });
      await same("bash", { command: "kill -9 $$" });
      await same("bash", { command: "true" });
      await same("bash", { command: "sleep 5", timeout: 0.2 }, true);
      await same("bash", { command: "echo x", timeout: -1 }, true);
    });

    it("truncates long output and keeps the full output in a file the tools can read", async () => {
      const command = "seq 1 5000";
      const result = (await run(routed, "bash", { command })) as {
        content: { text: string }[];
      };
      const text = result.content[0]?.text ?? "";
      expect(text).toContain("[Showing lines");
      const file = /Full output: (\S+)\]/.exec(text)?.[1] as string;
      expect(file).toBeTruthy();
      // The same call run locally truncates identically (apart from the temp file name).
      const expected = (await run(local, "bash", { command })) as { content: { text: string }[] };
      const strip = (t: string) => t.replace(/Full output: \S+\]/, "Full output]");
      expect(strip(text)).toBe(strip(expected.content[0]?.text ?? ""));
      // And the routed read tool (another uid in a pod) can read that file.
      const read = (await run(routed, "read", { path: file })) as { content: { text: string }[] };
      expect(read.content[0]?.text).toContain("1\n2\n3");
    });

    it("passes Pi's session variables, and no other variable of Pi", async () => {
      const bash = routed.get("bash") as ToolLike;
      const result = (await bash.execute(
        "call",
        { command: 'echo "[$PI_MODEL][$KOBE_SECRET_TEST]"' } as never,
        undefined,
        undefined,
        toolContext(),
      )) as Result;
      expect(JSON.stringify(result.content)).toContain("[m-1][]");
    });

    it("stops a running command when aborted", async () => {
      const controller = new AbortController();
      const pending = run(routed, "bash", { command: "echo go; sleep 30" }, controller.signal);
      await new Promise((r) => setTimeout(r, 300));
      const started = Date.now();
      controller.abort();
      const result = (await pending) as { error?: string };
      expect(result.error).toContain("Command aborted");
      expect(Date.now() - started).toBeLessThan(5000);
    });
  });

  describe("read", () => {
    it("reads text with offset and limit, and reports truncation like Pi", async () => {
      const file = path.join(work, "lines.txt");
      await writeFile(file, Array.from({ length: 3000 }, (_, i) => `line ${i + 1}`).join("\n"));
      await same("read", { path: file });
      await same("read", { path: "lines.txt", offset: 10, limit: 5 });
      await same("read", { path: "lines.txt", offset: 99999 }, true);
      await writeFile(path.join(work, "wide.txt"), "x".repeat(60_000));
      await same("read", { path: "wide.txt" });
    });

    it("fails on a missing file or a directory with Pi's messages", async () => {
      await same("read", { path: "missing.txt" }, true);
      await mkdir(path.join(work, "adir"), { recursive: true });
      await same("read", { path: "adir" }, true);
    });

    it("reads a multi-chunk file completely", async () => {
      const big = "0123456789".repeat(300_000); // 3 MB, three chunks
      await writeFile(path.join(work, "big.txt"), `${big}\nlast`);
      await same("read", { path: "big.txt", offset: 2, limit: 1 });
    });

    it("recognises images", async () => {
      // 1x1 PNG
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        "base64",
      );
      await writeFile(path.join(work, "p.png"), png);
      const actual = (await run(routed, "read", { path: "p.png" })) as {
        content: { type: string }[];
      };
      const expected = (await run(local, "read", { path: "p.png" })) as {
        content: { type: string }[];
      };
      expect(actual.content.map((c) => c.type)).toEqual(expected.content.map((c) => c.type));
      expect(actual.content.map((c) => c.type)).toContain("image");
    });
  });

  describe("write", () => {
    it("writes, creating parent directories, and says what Pi says", async () => {
      const file = "w/a/b.txt";
      const a = await run(routed, "write", { path: file, content: "héllo\nworld" });
      await rm(path.join(work, "w"), { recursive: true, force: true });
      const b = await run(local, "write", { path: file, content: "héllo\nworld" });
      expect(a).toEqual(b);
      expect(await readFile(path.join(work, file), "utf8")).toBe("héllo\nworld");
    });

    it("writes content larger than one chunk and replaces a longer file", async () => {
      await writeFile(path.join(work, "long.txt"), "x".repeat(100));
      const content = "é".repeat(1_500_000);
      await run(routed, "write", { path: "long.txt", content });
      expect(await readFile(path.join(work, "long.txt"), "utf8")).toBe(content);
      await run(routed, "write", { path: "long.txt", content: "" });
      expect(await readFile(path.join(work, "long.txt"), "utf8")).toBe("");
    });

    it("fails like Pi when the target is a directory", async () => {
      await mkdir(path.join(work, "dd"), { recursive: true });
      const a = (await run(routed, "write", { path: "dd", content: "x" })) as { error?: string };
      const b = (await run(local, "write", { path: "dd", content: "x" })) as { error?: string };
      expect(a.error).toMatch(/EISDIR/);
      expect(b.error).toMatch(/EISDIR/);
    });
  });

  describe("edit", () => {
    it("replaces text and returns the same diff details", async () => {
      const original = "alpha\r\nbeta\r\ngamma\r\n";
      await writeFile(path.join(work, "e1.txt"), original);
      const expected = await run(local, "edit", {
        path: "e1.txt",
        edits: [{ oldText: "beta", newText: "BETA" }],
      });
      const afterLocal = await readFile(path.join(work, "e1.txt"), "utf8");
      await writeFile(path.join(work, "e1.txt"), original);
      const actual = await run(routed, "edit", {
        path: "e1.txt",
        edits: [{ oldText: "beta", newText: "BETA" }],
      });
      expect(actual).toEqual(expected);
      expect(await readFile(path.join(work, "e1.txt"), "utf8")).toBe(afterLocal);
    });

    it("fails with Pi's messages", async () => {
      await writeFile(path.join(work, "e2.txt"), "one\ntwo\n");
      await same("edit", { path: "e2.txt", edits: [{ oldText: "absent", newText: "x" }] }, true);
      await same("edit", { path: "nope.txt", edits: [{ oldText: "a", newText: "b" }] }, true);
      await same("edit", { path: "e2.txt", edits: [] }, true);
    });
  });

  describe("ls", () => {
    it("lists like Pi: sorted, dotfiles, directory slashes, limits", async () => {
      const dir = path.join(work, "listing");
      await mkdir(path.join(dir, "Sub"), { recursive: true });
      for (const name of ["b.txt", "A.txt", ".hidden"]) await writeFile(path.join(dir, name), "");
      await symlink(path.join(dir, "gone"), path.join(dir, "broken"));
      await symlink(path.join(dir, "Sub"), path.join(dir, "link-to-dir"));
      await same("ls", { path: "listing" });
      await same("ls", { path: "listing", limit: 2 });
      await mkdir(path.join(work, "empty"), { recursive: true });
      await same("ls", { path: "empty" });
      await same("ls", { path: "listing/b.txt" }, true);
      await same("ls", { path: "nowhere" }, true);
    });

    it("asks the executor for a few round trips, not one per entry", async () => {
      const dir = path.join(work, "many");
      await mkdir(dir, { recursive: true });
      await Promise.all(
        Array.from({ length: 200 }, (_, i) => writeFile(path.join(dir, `f${i}.txt`), "")),
      );
      const sent: string[] = [];
      const [clientEnd, peer] = await socketPair();
      serveExecutor({ input: peer, output: peer, commandEnv: {} });
      clientEnd.on("data", () => undefined);
      const originalWrite = clientEnd.write.bind(clientEnd);
      clientEnd.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
        sent.push(String(chunk));
        return (originalWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
      }) as typeof clientEnd.write;
      const tools = collect(pi, new ExecClient(clientEnd), work);
      const result = (await run(tools, "ls", { path: "many" })) as { content: { text: string }[] };
      expect(result.content[0]?.text.split("\n")).toHaveLength(200);
      expect(sent.length).toBeLessThanOrEqual(4);
      clientEnd.destroy();
      peer.destroy();
    });
  });

  describe("grep", () => {
    const grepRoot = () => path.join(work, "grep");
    beforeAll(async () => {
      if (!PI_AVAILABLE) return;
      await mkdir(path.join(grepRoot(), "sub"), { recursive: true });
      await writeFile(path.join(grepRoot(), "a.txt"), "one\nneedle two\nthree\nNEEDLE four\n");
      await writeFile(
        path.join(grepRoot(), "sub/b.md"),
        "needle in b\n".repeat(3) + `${"x".repeat(700)} needle\n`,
      );
    });

    it("matches Pi's output and the arguments it passes to rg", async () => {
      await writeFile(log, "");
      const cases: Params[] = [
        { pattern: "needle", path: "grep" },
        { pattern: "needle", path: "grep", context: 1 },
        { pattern: "needle", path: "grep", ignoreCase: true, literal: true, limit: 3 },
        { pattern: "needle", path: "grep", glob: "*.md" },
        { pattern: "needle", path: "grep/a.txt" },
        { pattern: "absent", path: "grep" },
        { pattern: "needle", path: "nowhere" },
        { pattern: "FAIL", path: "grep" },
      ];
      for (const params of cases) {
        const before = (await invocations()).length;
        const expected = await run(local, "grep", params);
        const localCalls = (await invocations(before)).length;
        const actual = await run(routed, "grep", params);
        const all = await invocations(before);
        expect(actual, JSON.stringify(params)).toEqual(expected);
        expect(all.slice(localCalls), JSON.stringify(params)).toEqual(all.slice(0, localCalls));
      }
    });
  });

  describe("find", () => {
    it("matches Pi's output and the arguments it passes to fd", async () => {
      const dir = path.join(work, "finding");
      await mkdir(path.join(dir, "src"), { recursive: true });
      const listed = path.join(root, "fd-out.txt");
      await writeFile(listed, [`${dir}/a.ts`, `${dir}/src/b.ts`, `${dir}/src/`, ""].join("\n"));
      process.env.FAKE_FD_OUTPUT = listed;
      try {
        await writeFile(log, "");
        for (const params of [
          { pattern: "*.ts", path: "finding" },
          { pattern: "src/**/*.ts", path: "finding", limit: 2 },
          { pattern: "*.ts", path: "nowhere" },
        ]) {
          const before = (await invocations()).length;
          const expected = await run(local, "find", params);
          const localCalls = (await invocations(before)).length;
          const actual = await run(routed, "find", params);
          const all = await invocations(before);
          expect(actual, JSON.stringify(params)).toEqual(expected);
          expect(all.slice(localCalls), JSON.stringify(params)).toEqual(all.slice(0, localCalls));
        }
      } finally {
        delete process.env.FAKE_FD_OUTPUT;
      }
    });
  });
});
