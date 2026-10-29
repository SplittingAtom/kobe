import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { splitRenderedPrompt } from "../context/system-prompt.js";
import type { ExecTransport } from "../kobe-exec/client.js";
import { registerExecTools, TOOL_NAMES, type PiToolFactories } from "../kobe-exec/tools.js";
import { registerKobeModels, type ExtensionApiLike as ModelsApi } from "../kobe-models/register.js";
import type { ModelFileState } from "../kobe-models/protocol.js";
import {
  registerKobePolicy,
  type ExtensionApiLike as PolicyApi,
} from "../kobe-policy/extension.js";
import { registerKobeTools, type ExtensionApiLike as ToolsApi } from "../kobe-tools/extension.js";
import type { ToolsTransport } from "../kobe-tools/tools.js";

/**
 * The Pi extension API that kobe-exec, kobe-models, kobe-policy and kobe-tools bind to (KOBE-511),
 * checked against the pinned Pi in images/sandbox/pi. The extensions declare Pi's API structurally
 * (no Pi types at compile time) and some bind optionally (kobe-tools installs its memory hooks only
 * when `on`/`getActiveTools`/`setActiveTools` exist), so a renamed method or event would fail
 * quietly at runtime. This suite makes a Pi bump fail here instead: it pins the verified version,
 * registers each extension through Pi's real extension loader, and checks the exports, event names,
 * event fields and prompt section names the extensions use. On a bump: re-read Pi's CHANGELOG,
 * re-run the real-Pi suites, then update VERIFIED_PI (docs/ledger/KOBE-511.md has the checklist).
 */
const VERIFIED_PI = "1.4.0";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PI_DIR = path.resolve(HERE, "../../../../images/sandbox/pi");
const SCOPE = path.join(PI_DIR, "node_modules/@earendil-works");
const CODING = path.join(SCOPE, "pi-coding-agent");
const INSTALLED = existsSync(path.join(CODING, "package.json"));
if (process.env.CI !== undefined && !INSTALLED) {
  throw new Error(`Pi is not installed in ${PI_DIR} (npm ci --prefix images/sandbox/pi)`);
}

type Fn = (...args: never[]) => unknown;
type Module = Record<string, unknown>;
const importFrom = async (file: string): Promise<Module> =>
  (await import(pathToFileURL(file).href)) as Module;
const piDist = (rel: string) => importFrom(path.join(CODING, "dist", rel));
const readJson = (file: string) =>
  JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;

interface LoadedExtension {
  readonly handlers: Map<string, unknown[]>;
  readonly tools: Map<string, { readonly definition: Record<string, unknown> }>;
}

/** Load `register` as an inline extension through Pi's own loader; returns what it registered. */
async function loadThroughPi(
  register: (api: Record<string, Fn>) => unknown,
): Promise<{ extension: LoadedExtension; api: Record<string, Fn> }> {
  const pi = await piDist("index.js");
  const loader = await piDist("core/extensions/loader.js");
  let captured: Record<string, Fn> | undefined;
  const extension = (await (loader.loadExtensionFromFactory as Fn)(
    (async (api: Record<string, Fn>) => {
      captured = api;
      await register(api);
    }) as never,
    process.cwd() as never,
    (pi.createEventBus as Fn)() as never,
    (pi.createExtensionRuntime as Fn)() as never,
  )) as LoadedExtension;
  if (captured === undefined) throw new Error("Pi did not call the extension factory");
  return { extension, api: captured };
}

/** The `on(event: "...")` overloads of Pi's `ExtensionAPI` (the events an extension can bind). */
function declaredEvents(): Set<string> {
  const types = readFileSync(path.join(CODING, "dist/core/extensions/types.d.ts"), "utf8");
  return new Set([...types.matchAll(/\bon\(event: "([a-z_]+)"/g)].map((m) => m[1] ?? ""));
}

/** The body of `interface <name>` in Pi's extension types. */
function interfaceBody(name: string): string {
  const types = readFileSync(path.join(CODING, "dist/core/extensions/types.d.ts"), "utf8");
  const start = types.search(new RegExp(`interface ${name}(<[^{]*>)? (extends [^{]+)?\\{`));
  if (start < 0) throw new Error(`Pi no longer declares interface ${name}`);
  return types.slice(start, types.indexOf("\n}", start));
}

const unusedExec: ExecTransport = { request: () => Promise.reject(new Error("unused")) };
const unusedTools: ToolsTransport = { request: () => Promise.reject(new Error("unused")) };

describe("the pinned Pi version", () => {
  it("is the version this surface was verified against", () => {
    const pkg = readJson(path.join(PI_DIR, "package.json"));
    const deps = pkg.dependencies as Record<string, string>;
    expect(deps["@earendil-works/pi-coding-agent"]).toBe(VERIFIED_PI);
  });

  it.runIf(INSTALLED)("is the version installed", () => {
    expect(readJson(path.join(CODING, "package.json")).version).toBe(VERIFIED_PI);
  });
});

describe.runIf(INSTALLED)("Pi's extension API as the Kobe extensions bind to it", () => {
  it("offers every ExtensionAPI method the extensions call", async () => {
    const { api } = await loadThroughPi(() => undefined);
    for (const method of [
      "on",
      "registerTool",
      "registerProvider",
      "setModel",
      "getActiveTools",
      "setActiveTools",
    ]) {
      expect(typeof api[method], `ExtensionAPI.${method}`).toBe("function");
    }
  });

  it("kobe-exec: Pi's tool factories and helpers exist with the arity kobe-exec calls", async () => {
    const pi = await piDist("index.js");
    for (const name of TOOL_NAMES) {
      const factory = `create${name[0]?.toUpperCase() ?? ""}${name.slice(1)}ToolDefinition`;
      expect(typeof pi[factory], factory).toBe("function");
      const def = (pi[factory] as Fn)("/w" as never, { operations: {} } as never) as Module;
      expect(def.name).toBe(name);
      expect(typeof def.parameters).toBe("object");
      // execute(toolCallId, params, signal, onUpdate, ctx): kobe-exec passes ctx.cwd through.
      expect((def.execute as Fn).length).toBe(5);
    }
    for (const name of [
      "truncateHead",
      "truncateLine",
      "formatSize",
      "detectSupportedImageMimeTypeFromFile",
    ]) {
      expect(typeof pi[name], name).toBe("function");
    }
    expect(typeof pi.DEFAULT_MAX_BYTES).toBe("number");
  });

  it("kobe-exec: registers the seven tools and the user_bash route through Pi's loader", async () => {
    const pi = await piDist("index.js");
    const { extension } = await loadThroughPi((api) =>
      registerExecTools(api as never, unusedExec, pi as unknown as PiToolFactories, "/w"),
    );
    expect([...extension.tools.keys()].sort()).toEqual([...TOOL_NAMES].sort());
    for (const name of ["ls", "grep", "find"]) {
      expect(extension.tools.get(name)?.definition.defaultActive).toBe(false);
    }
    expect(extension.handlers.has("user_bash")).toBe(true);
    expect(interfaceBody("ToolDefinition")).toMatch(/defaultActive\?: boolean;/);
  });

  it("kobe-tools: registers its tools and all four memory hooks through Pi's loader", async () => {
    const { extension } = await loadThroughPi((api) =>
      registerKobeTools(api as unknown as ToolsApi, unusedTools, {
        files: true,
        projects: true,
        skillDrafts: true,
        fileEdits: true,
        notebooks: true,
        memory: true,
      }),
    );
    expect(extension.tools.size).toBeGreaterThanOrEqual(10);
    // Optional binding: a renamed getActiveTools/setActiveTools would silently skip the hooks.
    for (const event of ["tool_call", "input", "before_agent_start", "context"]) {
      expect(extension.handlers.has(event), event).toBe(true);
    }
    expect(interfaceBody("ToolDefinition")).toMatch(/promptSnippet\?: string;/);
    expect(interfaceBody("ToolDefinition")).toMatch(/promptGuidelines\?: string\[\];/);
  });

  it("kobe-policy: binds tool_call through Pi's loader", async () => {
    const { extension } = await loadThroughPi((api) =>
      registerKobePolicy(
        api as unknown as PolicyApi,
        Promise.resolve({
          checker: { check: async () => ({ allow: true }) },
          announce: () => undefined,
        }),
      ),
    );
    expect(extension.handlers.has("tool_call")).toBe(true);
  });

  it("kobe-models: registers the provider through Pi's loader with Pi's own pi-ai", async () => {
    // Pi's loader resolves an extension's `@earendil-works/pi-ai` to pi-ai's `compat` entry
    // (core/extensions/loader.js); pi-ai marks it temporary, so its removal must fail here.
    const ai = await importFrom(path.join(SCOPE, "pi-ai/dist/compat.js"));
    const loaderSource = readFileSync(path.join(CODING, "dist/core/extensions/loader.js"), "utf8");
    expect(loaderSource).toMatch(/"@earendil-works\/pi-ai": piAiCompatEntry/);
    for (const name of [
      "createProvider",
      "createAssistantMessageEventStream",
      "openAICompletionsApi",
      "anthropicMessagesApi",
      "googleGenerativeAIApi",
    ]) {
      expect(typeof ai[name], name).toBe("function");
    }
    const state: ModelFileState = {
      v: 1,
      gateway_url: "http://gw",
      model: { gateway_model: "openai/gpt-fake", api: "openai-completions" },
      token: "t".repeat(40),
      run_id: null,
    };
    const api = (name: string) => (ai[name] as Fn)() as never;
    const { extension } = await loadThroughPi((piApi) =>
      registerKobeModels(piApi as unknown as ModelsApi, {
        env: { KOBE_MODEL_FILE: "/x/model.json" },
        readState: async () => state,
        pi: {
          createProvider: ai.createProvider as never,
          createAssistantMessageEventStream: ai.createAssistantMessageEventStream as never,
        },
        apis: {
          "openai-completions": api("openAICompletionsApi"),
          "anthropic-messages": api("anthropicMessagesApi"),
          "google-generative-ai": api("googleGenerativeAIApi"),
        },
        warn: (message) => {
          throw new Error(message);
        },
      }),
    );
    expect(extension.handlers.has("input")).toBe(true);
    expect(extension.handlers.has("session_before_compact")).toBe(true);
  });

  it("declares every event the extensions bind, with the fields they read and return", () => {
    const events = declaredEvents();
    for (const event of [
      "before_agent_start",
      "context",
      "input",
      "session_before_compact",
      "tool_call",
      "user_bash",
    ]) {
      expect(events.has(event), event).toBe(true);
    }
    // kobe-tools memory hooks: read `systemPrompt`, return `{ systemPrompt }`; `context` messages.
    expect(interfaceBody("BeforeAgentStartEventBase")).toMatch(/readonly systemPrompt: string;/);
    expect(interfaceBody("BeforeAgentStartEventResult")).toMatch(/systemPrompt\?: string;/);
    expect(interfaceBody("ContextEvent")).toMatch(/messages: AgentMessage\[\];/);
    expect(interfaceBody("ContextEventResult")).toMatch(/messages\?: AgentMessage\[\];/);
    // kobe-policy: `{ block, reason }`.
    expect(interfaceBody("ToolCallEventResult")).toMatch(
      /block\?: boolean;[\s\S]*reason\?: string;/,
    );
  });

  it("names the system prompt sections the context viewer splits (CV3)", async () => {
    const sp = await piDist("core/system-prompt.js");
    const options = {
      cwd: "/w",
      selectedTools: ["read", "bash"],
      toolSnippets: { read: "Read files", bash: "Run commands" },
      appendSystemPrompt: "AGENT INSTRUCTIONS",
      contextFiles: [{ path: "/w/AGENTS.md", content: "context file" }],
      skills: [],
    };
    const sections = (sp.buildSystemPromptSections as Fn)(options as never) as Record<
      string,
      string
    >;
    expect(Object.keys(sections)).toEqual([
      "preamble",
      "tools",
      "rules",
      "docs",
      "addendum",
      "project_context",
      "cwd",
    ]);
    const rendered = (sp.buildSystemPrompt as Fn)(options as never) as string;
    const split = splitRenderedPrompt(rendered);
    expect(split.map((s) => s.label)).toEqual([
      "Pi's prompt",
      "Tool guidance",
      "Rules",
      "Pi documentation",
      "Agent instructions",
      "Context files",
      "Working directory",
    ]);
  });
});
