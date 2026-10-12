import { randomUUID } from "node:crypto";
import pino from "pino";
import { beforeEach, describe, expect, it } from "vitest";
import {
  SITE_CUSTOMER,
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
  it("maps D30's hierarchy: site customer, a team per Kobe team, a key per member", () => {
    const d = desired();
    expect(d.customer.name).toBe(SITE_CUSTOMER);
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
    expect([...bifrost.customers.values()].map((c) => c.name)).toEqual([SITE_CUSTOMER]);
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

  /** An install synced before KOBE-256: every team under the old `kobe-install` customer. */
  const syncedBeforeRename = async () => {
    const old = { ...desired(), customer: { name: "kobe-install", limits: undefined } };
    const first = await reconcile(old, bifrost, logger);
    expect([...bifrost.customers.values()].map((c) => c.name)).toEqual(["kobe-install"]);
    bifrost.calls.length = 0;
    return { first, legacy: [...bifrost.customers.values()][0] };
  };
  const teamCustomers = () => [...bifrost.teams.values()].map((t) => t.customerId);
  const vkWrites = () => bifrost.calls.filter((c) => c.startsWith("vk."));

  it("KOBE-265: Bifrost keeps a team's customer on update (the fake matches v2.2.5)", async () => {
    const { legacy } = await syncedBeforeRename();
    const other = await bifrost.addCustomer("other");
    const [team] = [...bifrost.teams.values()];
    await bifrost.updateTeam(team?.id ?? "", other.id);
    expect(bifrost.teams.get(team?.id ?? "")?.customerId).toBe(legacy?.id);
    // Deleting a customer detaches its teams; a team without a customer can be attached.
    await bifrost.deleteCustomer(legacy?.id ?? "");
    expect(bifrost.teams.get(team?.id ?? "")?.customerId).toBeUndefined();
    await bifrost.updateTeam(team?.id ?? "", other.id);
    expect(bifrost.teams.get(team?.id ?? "")?.customerId).toBe(other.id);
  });

  it("KOBE-265: renames kobe-install to the site customer in place, then converges", async () => {
    expect(SITE_CUSTOMER).toBe("kobe-site");
    const { first, legacy } = await syncedBeforeRename();
    const result = await reconcile(desired(), bifrost, logger);
    expect(result.errors).toEqual([]);
    expect(bifrost.calls).toEqual([`customer.update kobe-install ${SITE_CUSTOMER}`]);
    expect([...bifrost.customers.values()]).toEqual([{ id: legacy?.id, name: SITE_CUSTOMER }]);
    expect(teamCustomers()).toEqual([legacy?.id, legacy?.id]);
    expect(result.virtualKeys).toEqual(first.virtualKeys);
    expect(vkWrites()).toEqual([]);
    const again = await reconcile(desired(), bifrost, logger);
    expect(again.changes).toBe(0);
    expect(again.errors).toEqual([]);
  });

  it("KOBE-265: after KOBE-256's create-and-move, deletes the empty kobe-site, then renames", async () => {
    const { first, legacy } = await syncedBeforeRename();
    // What KOBE-256 left on kobe-gate1: kobe-site created, every team still on kobe-install.
    await bifrost.addCustomer(SITE_CUSTOMER);
    for (const t of bifrost.teams.values()) await bifrost.updateTeam(t.id, "ignored");
    bifrost.calls.length = 0;
    const result = await reconcile(desired(), bifrost, logger);
    expect(result.errors).toEqual([]);
    expect(bifrost.calls).toEqual([
      `customer.delete ${SITE_CUSTOMER}`,
      `customer.update kobe-install ${SITE_CUSTOMER}`,
    ]);
    expect([...bifrost.customers.values()]).toEqual([{ id: legacy?.id, name: SITE_CUSTOMER }]);
    expect(teamCustomers()).toEqual([legacy?.id, legacy?.id]);
    expect(result.virtualKeys).toEqual(first.virtualKeys);
    expect((await reconcile(desired(), bifrost, logger)).changes).toBe(0);
  });

  it("KOBE-265: keeps kobe-install with its teams while the rename fails, then heals", async () => {
    const { first, legacy } = await syncedBeforeRename();
    bifrost.failing.add("customer.update kobe-install");
    const failed = await reconcile(desired(), bifrost, logger);
    expect(failed.errors).not.toEqual([]);
    expect([...bifrost.customers.values()]).toEqual([{ id: legacy?.id, name: "kobe-install" }]);
    expect(teamCustomers()).toEqual([legacy?.id, legacy?.id]);
    expect(bifrost.calls.some((c) => c.startsWith("customer.delete"))).toBe(false);
    expect(failed.virtualKeys).toEqual(first.virtualKeys);
    bifrost.failing.clear();
    expect((await reconcile(desired(), bifrost, logger)).errors).toEqual([]);
    expect([...bifrost.customers.values()].map((c) => c.name)).toEqual([SITE_CUSTOMER]);
    expect((await reconcile(desired(), bifrost, logger)).changes).toBe(0);
  });

  it("KOBE-265: renames nothing while the stray kobe-site cannot be deleted", async () => {
    const { legacy } = await syncedBeforeRename();
    await bifrost.addCustomer(SITE_CUSTOMER);
    bifrost.failing.add(`customer.delete ${SITE_CUSTOMER}`);
    const failed = await reconcile(desired(), bifrost, logger);
    expect(failed.errors).not.toEqual([]);
    expect([...bifrost.customers.values()].map((c) => c.name).sort()).toEqual([
      "kobe-install",
      SITE_CUSTOMER,
    ]);
    expect(teamCustomers()).toEqual([legacy?.id, legacy?.id]);
    bifrost.failing.clear();
    expect((await reconcile(desired(), bifrost, logger)).errors).toEqual([]);
    expect([...bifrost.customers.values()]).toEqual([{ id: legacy?.id, name: SITE_CUSTOMER }]);
  });

  it("KOBE-265: a new team joins the legacy customer that is being renamed", async () => {
    const { legacy } = await syncedBeforeRename();
    const teamC = randomUUID();
    const more = desired({ teams: [...teams, { teamId: teamC, members: [bob], aliases: [] }] });
    expect((await reconcile(more, bifrost, logger)).errors).toEqual([]);
    expect(teamCustomers()).toEqual([legacy?.id, legacy?.id, legacy?.id]);
    expect([...bifrost.customers.values()].map((c) => c.name)).toEqual([SITE_CUSTOMER]);
  });

  it("KOBE-265: attaches a team that lost its customer; leaves one under a foreign customer", async () => {
    await reconcile(desired(), bifrost, logger);
    const [site] = [...bifrost.customers.values()];
    const [a, b] = [...bifrost.teams.values()];
    if (!a || !b) throw new Error("expected two teams");
    bifrost.teams.set(a.id, { ...a, customerId: undefined });
    const foreign = await bifrost.addCustomer("someone-else");
    bifrost.teams.set(b.id, { ...b, customerId: foreign.id });
    bifrost.calls.length = 0;
    const result = await reconcile(desired(), bifrost, logger);
    expect(result.errors).toEqual([]);
    expect(bifrost.calls).toEqual([`team.update ${a.name}`]);
    expect(teamCustomers()).toEqual([site?.id, foreign.id]);
    // The foreign customer still owns a team: never deleted (Bifrost would detach the team).
    expect((await reconcile(desired(), bifrost, logger)).changes).toBe(0);
    expect(vkWrites()).toEqual([]);
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

  it("KOBE-42: pushes each member's request rate as a virtual-key rate limit, only when it changed", async () => {
    const rated = (rpm: number) => teams.map((t) => ({ ...t, requestsPerMinute: rpm }));
    await reconcile(desired({ teams: rated(60) }), bifrost, logger);
    const name = virtualKeyName(teamA, bob);
    const vk = () => [...bifrost.virtualKeys.values()].find((v) => v.name === name);
    expect(vk()?.requestsPerMinute).toBe(60);
    expect((await reconcile(desired({ teams: rated(60) }), bifrost, logger)).changes).toBe(0);
    const lowered = await reconcile(desired({ teams: rated(10) }), bifrost, logger);
    expect(lowered.changes).toBe(3); // three virtual keys
    expect(vk()?.requestsPerMinute).toBe(10);
  });

  it("deactivates a virtual key whose team has no model enabled (fails closed)", async () => {
    await reconcile(desired(), bifrost, logger);
    const vk = () =>
      [...bifrost.virtualKeys.values()].find((v) => v.name === virtualKeyName(teamA, alice));
    expect(vk()?.isActive).toBe(true);
    const none = teams.map((t) => (t.teamId === teamA ? { ...t, aliases: [] } : t));
    await reconcile(desired({ teams: none }), bifrost, logger);
    expect(vk()).toMatchObject({ isActive: false, models: {} });
    // Team B never had a model: its key was created inactive.
    const b = [...bifrost.virtualKeys.values()].find(
      (v) => v.name === virtualKeyName(teamB, alice),
    );
    expect(b?.isActive).toBe(false);
    await reconcile(desired(), bifrost, logger);
    expect(vk()?.isActive).toBe(true);
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
