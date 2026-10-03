import { randomUUID } from "node:crypto";
import pino from "pino";
import { beforeEach, describe, expect, it } from "vitest";
import {
  INSTALL_CUSTOMER,
  buildDesiredState,
  gatewayTeamName,
  keyName,
  virtualKeyName,
  type ProviderInput,
  type TeamInput,
} from "./desired.js";
import { reconcile } from "./reconcile.js";
import { FakeBifrost } from "./testing/fake-bifrost.js";

const logger = pino({ level: "silent" });
const SECRET = "f".repeat(40);
const teamA = randomUUID();
const teamB = randomUUID();
const alice = randomUUID();
const bob = randomUUID();

const providers: ProviderInput[] = [
  { id: "openai", kind: "openai", baseUrl: null, allowPrivateNetwork: false, apiKey: "sk-openai" },
  {
    id: "anthropic",
    kind: "anthropic",
    baseUrl: null,
    allowPrivateNetwork: false,
    apiKey: "sk-ant",
  },
  {
    id: "gemini",
    kind: "gemini",
    baseUrl: null,
    allowPrivateNetwork: false,
    apiKey: "g-key",
  },
  {
    id: "ollama",
    kind: "ollama",
    baseUrl: "http://ollama.lan:11434",
    allowPrivateNetwork: true,
    apiKey: undefined,
  },
  {
    id: "vllm",
    kind: "openai_compatible",
    baseUrl: "http://vllm.lan:8000",
    allowPrivateNetwork: true,
    apiKey: undefined,
  },
];
const catalog = [
  { alias: "smart", providerId: "anthropic", model: "claude-sonnet-4-5" },
  { alias: "fast", providerId: "openai", model: "gpt-5-mini" },
  { alias: "gem", providerId: "gemini", model: "gemini-2.5-pro" },
  { alias: "local", providerId: "ollama", model: "llama3.3" },
  { alias: "qwen", providerId: "vllm", model: "qwen/qwen3-8b" },
];
const teams: TeamInput[] = [
  { teamId: teamA, members: [alice, bob], aliases: ["smart", "fast", "local", "qwen", "gem"] },
  { teamId: teamB, members: [alice], aliases: [] },
];

const desired = (over: Partial<{ providers: ProviderInput[]; teams: TeamInput[] }> = {}) =>
  buildDesiredState(
    { providers: over.providers ?? providers, catalog, teams: over.teams ?? teams },
    SECRET,
  );

describe("buildDesiredState", () => {
  it("maps D30's hierarchy: install customer, a team per Kobe team, a key per member", () => {
    const d = desired();
    expect(d.customer.name).toBe(INSTALL_CUSTOMER);
    expect(d.teams.map((t) => t.name)).toEqual([gatewayTeamName(teamA), gatewayTeamName(teamB)]);
    expect(d.virtualKeys.map((v) => v.name)).toEqual([
      virtualKeyName(teamA, alice),
      virtualKeyName(teamA, bob),
      virtualKeyName(teamB, alice),
    ]);
  });

  it("allows a team's members exactly its enabled models, per gateway provider", () => {
    const [a, , b] = desired().virtualKeys;
    expect(a?.models).toEqual({
      anthropic: ["claude-sonnet-4-5"],
      gemini: ["gemini-2.5-pro"],
      "kobe-vllm": ["qwen/qwen3-8b"],
      ollama: ["llama3.3"],
      openai: ["gpt-5-mini"],
    });
    // A team with nothing enabled can call nothing (deny by default).
    expect(b?.models).toEqual({});
  });

  it("names OpenAI-compatible providers kobe-<id> and keys by a fingerprint of the material", () => {
    const d = desired();
    const vllm = d.providers.find((p) => p.name === "kobe-vllm");
    expect(vllm).toMatchObject({ custom: true, keyless: true, key: undefined });
    const ollama = d.providers.find((p) => p.name === "ollama");
    expect(ollama?.key).toMatchObject({ value: "", ollamaUrl: "http://ollama.lan:11434" });
    const openai = d.providers.find((p) => p.name === "openai");
    expect(openai?.key?.name).toBe(keyName("openai", "sk-openai", SECRET));
    expect(openai?.key?.name).not.toContain("sk-openai");
  });
});

describe("reconcile", () => {
  let bifrost: FakeBifrost;
  beforeEach(() => {
    bifrost = new FakeBifrost();
  });

  it("builds everything on an empty Bifrost and returns every member's virtual key", async () => {
    const result = await reconcile(desired(), bifrost, logger);
    expect(result.errors).toEqual([]);
    expect([...bifrost.providers.keys()].sort()).toEqual([
      "anthropic",
      "gemini",
      "kobe-vllm",
      "ollama",
      "openai",
    ]);
    expect(bifrost.keyValue("anthropic")).toBe("sk-ant");
    expect(bifrost.providers.get("kobe-vllm")?.keys).toEqual([]);
    expect([...bifrost.customers.values()].map((c) => c.name)).toEqual([INSTALL_CUSTOMER]);
    expect(bifrost.teams.size).toBe(2);
    expect([...result.virtualKeys.keys()]).toHaveLength(3);
    for (const { value } of result.virtualKeys.values()) expect(value).toMatch(/^sk-bf-/);
  });

  it("is idempotent: a second pass writes nothing and returns the same keys", async () => {
    const first = await reconcile(desired(), bifrost, logger);
    const calls = bifrost.calls.length;
    const second = await reconcile(desired(), bifrost, logger);
    expect(second.changes).toBe(0);
    expect(bifrost.calls.length).toBe(calls);
    expect(second.virtualKeys).toEqual(first.virtualKeys);
  });

  it("pushes a changed key (new key first, then the old one goes) and a changed URL", async () => {
    await reconcile(desired(), bifrost, logger);
    bifrost.calls.length = 0;
    const rotated = providers.map((p) =>
      p.id === "openai"
        ? { ...p, apiKey: "sk-rotated" }
        : p.id === "vllm"
          ? { ...p, baseUrl: "http://vllm2.lan:8000" }
          : p,
    );
    const result = await reconcile(desired({ providers: rotated }), bifrost, logger);
    expect(result.errors).toEqual([]);
    expect(bifrost.keyValue("openai")).toBe("sk-rotated");
    expect(bifrost.providers.get("openai")?.keys).toHaveLength(1);
    const keyCalls = bifrost.calls.filter((c) => c.startsWith("key."));
    expect(keyCalls[0]).toMatch(/^key\.add openai /);
    expect(keyCalls[1]).toBe("key.delete openai");
    expect(bifrost.providers.get("kobe-vllm")?.baseUrl).toBe("http://vllm2.lan:8000");
  });

  it("updates a team's virtual keys when its enabled models change, keeping their values", async () => {
    const first = await reconcile(desired(), bifrost, logger);
    const narrowed = teams.map((t) => (t.teamId === teamA ? { ...t, aliases: ["smart"] } : t));
    const second = await reconcile(desired({ teams: narrowed }), bifrost, logger);
    const name = virtualKeyName(teamA, alice);
    const vk = [...bifrost.virtualKeys.values()].find((v) => v.name === name);
    expect(vk?.models).toEqual({ anthropic: ["claude-sonnet-4-5"] });
    expect(second.virtualKeys.get(name)).toEqual(first.virtualKeys.get(name));
  });

  it("removes what is no longer desired: a removed member's key, a team, a provider", async () => {
    await reconcile(desired(), bifrost, logger);
    const smaller = {
      providers: providers.filter((p) => p.id !== "gemini"),
      teams: [{ teamId: teamA, members: [alice], aliases: ["smart"] }],
    };
    const result = await reconcile(desired(smaller), bifrost, logger);
    expect(result.errors).toEqual([]);
    expect([...bifrost.virtualKeys.values()].map((v) => v.name)).toEqual([
      virtualKeyName(teamA, alice),
    ]);
    expect([...bifrost.teams.values()].map((t) => t.name)).toEqual([gatewayTeamName(teamA)]);
    expect(bifrost.providers.has("gemini")).toBe(false);
  });

  it("removes foreign objects and duplicate virtual keys (Kobe owns the gateway)", async () => {
    await reconcile(desired(), bifrost, logger);
    await bifrost.addProvider({
      name: "mistral",
      custom: false,
      keyless: false,
      baseUrl: undefined,
      allowPrivateNetwork: false,
    });
    const stray = await bifrost.addCustomer("someone-else");
    const team = [...bifrost.teams.values()][0];
    if (!team) throw new Error("no team");
    await bifrost.addVirtualKey({
      name: virtualKeyName(teamA, alice),
      teamId: team.id,
      models: {},
    });
    await bifrost.addVirtualKey({ name: "hand-made", teamId: team.id, models: {} });
    await reconcile(desired(), bifrost, logger);
    expect(bifrost.providers.has("mistral")).toBe(false);
    expect(bifrost.customers.has(stray.id)).toBe(false);
    const names = [...bifrost.virtualKeys.values()].map((v) => v.name);
    expect(names.filter((n) => n === virtualKeyName(teamA, alice))).toHaveLength(1);
    expect(names).not.toContain("hand-made");
  });

  it("rebuilds a wiped Bifrost (pod restarted without persistence) with new key values", async () => {
    const first = await reconcile(desired(), bifrost, logger);
    bifrost.wipe();
    const second = await reconcile(desired(), bifrost, logger);
    expect(second.errors).toEqual([]);
    const name = virtualKeyName(teamA, alice);
    expect(second.virtualKeys.get(name)?.value).not.toBe(first.virtualKeys.get(name)?.value);
  });

  it("reports an unreachable Bifrost as an error code, changing nothing", async () => {
    bifrost.down = true;
    const result = await reconcile(desired(), bifrost, logger);
    expect(result).toEqual({ virtualKeys: new Map(), changes: 0, errors: ["bifrost_unreachable"] });
  });
});
