// @vitest-environment happy-dom
import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, beforeEach } from "vitest";
import { must } from "../../lib/testing/must";
import { MemorySwitchesSection } from "./site/memory-switches";
import { TeamMemoryPage } from "./team/memory-page";
import { forbidNativeConfirm, renderSite, renderTeam, stubApi } from "./testing";

beforeEach(forbidNativeConfirm);

afterEach(cleanup);

const TEAM = "/v1/memory/settings?level=team";
const EFFECTIVE = "/v1/memory/settings?level=effective";
const MODELS = "/v1/team/models";
const SITE = "/v1/memory/settings?level=site";

const WS_ON = {
  memory_enabled: true,
  project_memory_enabled: true,
  memories_enabled: true,
  workspace_memories_enabled: true,
  site_memories_enabled: true,
  learn_enabled: true,
  site_proposals_enabled: true,
  learning_model_alias: null,
};
const EFFECTIVE_ON = {
  memory_enabled: true,
  project_memory_enabled: true,
  memories_enabled: true,
  scopes: { user: true, portable: true, team: true, site: true },
  policy: true,
  site_proposals_enabled: true,
  learn: {
    available: false,
    reason: "no_learning_model",
    message: "No learning model is set.",
  },
};
const model = (alias: string, enabled: boolean) => ({
  alias,
  label: null,
  provider_id: "p",
  model: alias,
  enabled,
  is_default: false,
});
const MODELS_BODY = { models: [model("fast", true), model("slow", false)], default: "fast" };

type Routes = Parameters<typeof stubApi>[0];
const teamRoutes = (extra: Routes = {}): Routes => ({
  [`GET ${TEAM}`]: [200, WS_ON],
  [`GET ${EFFECTIVE}`]: [200, EFFECTIVE_ON],
  [`GET ${MODELS}`]: [200, MODELS_BODY],
  ...extra,
});
const putBody = (calls: ReturnType<typeof stubApi>, url = TEAM) =>
  JSON.parse(String(must(calls.find((c) => c.method === "PUT" && c.url === url)).body)) as unknown;
const box = (name: RegExp) => screen.findByRole("checkbox", { name });

const WORKSPACE_LABELS = [
  /Allow memory in this workspace/,
  /Allow project notes/,
  /Allow memories/,
  /Workspace memories/,
  /Site memories reach this workspace's runs/,
  /Learn from this chat/,
  /Members may propose to the Site/,
];

describe("Workspace settings › Memory (KOBE-381 ac-3)", () => {
  it("shows every switch with a plain explanation, all on by default", async () => {
    stubApi(teamRoutes());
    renderTeam(<TeamMemoryPage />);
    for (const name of WORKSPACE_LABELS) {
      expect(((await box(name)) as HTMLInputElement).checked, String(name)).toBe(true);
    }
    expect(screen.getByText(/Site Policy reaches this workspace's runs even when this is off/));
    expect(screen.queryByText(/language/i)).toBeNull();
  });

  it("saves every switch: turning each one off sends it", async () => {
    const off = Object.fromEntries(
      Object.keys(WS_ON)
        .filter((k) => k !== "learning_model_alias")
        .map((k) => [k, false]),
    );
    const calls = stubApi(teamRoutes({ [`PUT ${TEAM}`]: [200, { ...WS_ON, ...off }] }));
    renderTeam(<TeamMemoryPage />);
    // Children first: a switch is disabled while what it needs is off.
    for (const name of [...WORKSPACE_LABELS].reverse()) await userEvent.click(await box(name));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText(/Memory is off in this workspace.*nothing stored was deleted/i);
    expect(putBody(calls)).toEqual(off);
    expect(must(calls.find((c) => c.method === "PUT")).headers.get("x-kobe-team")).toBe("t-1");
  });

  it("Site memories can be turned off alone", async () => {
    const calls = stubApi(
      teamRoutes({ [`PUT ${TEAM}`]: [200, { ...WS_ON, site_memories_enabled: false }] }),
    );
    renderTeam(<TeamMemoryPage />);
    await userEvent.click(await box(/Site memories reach/));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText(/Memory settings saved in this workspace/);
    expect(putBody(calls)).toMatchObject({ site_memories_enabled: false, memory_enabled: true });
  });

  it("disables what needs memory while the master switch is off", async () => {
    stubApi(teamRoutes({ [`GET ${TEAM}`]: [200, { ...WS_ON, memory_enabled: false }] }));
    renderTeam(<TeamMemoryPage />);
    for (const name of WORKSPACE_LABELS.slice(1)) {
      expect(((await box(name)) as HTMLInputElement).disabled, String(name)).toBe(true);
    }
  });

  it("learning model: offers enabled models only, saves the choice, shows why Learn is off", async () => {
    const calls = stubApi(
      teamRoutes({ [`PUT ${TEAM}`]: [200, { ...WS_ON, learning_model_alias: "fast" }] }),
    );
    renderTeam(<TeamMemoryPage />);
    await screen.findByText(/Learn from this chat is unavailable: No learning model is set/);
    const select = await screen.findByRole("combobox", {
      name: /Learning model for this workspace/,
    });
    const options = [...(select as HTMLSelectElement).options].map((o) => o.value);
    expect(options).toEqual(["", "fast"]);
    expect(screen.getByText(/never falls back to another model or the conversation's model/));
    await userEvent.selectOptions(select, "fast");
    await userEvent.click(screen.getByRole("button", { name: "Save learning model" }));
    await screen.findByText(/This workspace's learning model is fast/);
    expect(putBody(calls)).toEqual({ learning_model_alias: "fast" });
  });

  it("M2: a stored model that is no longer enabled shows as such and can be cleared", async () => {
    const calls = stubApi(
      teamRoutes({
        [`GET ${TEAM}`]: [200, { ...WS_ON, learning_model_alias: "slow" }],
        [`PUT ${TEAM}`]: [200, WS_ON],
      }),
    );
    renderTeam(<TeamMemoryPage />);
    const select = (await screen.findByRole("combobox", {
      name: /Learning model for this workspace/,
    })) as HTMLSelectElement;
    expect(select.value).toBe("slow");
    expect([...select.options].map((o) => o.text)).toEqual(["None", "slow (not enabled)", "fast"]);
    await userEvent.selectOptions(select, "");
    await userEvent.click(screen.getByRole("button", { name: "Save learning model" }));
    await screen.findByText(/uses the site's learning model/);
    expect(putBody(calls)).toEqual({ learning_model_alias: null });
  });

  it("L8: turning a workspace's memory off says Site Policy still applies", async () => {
    stubApi(teamRoutes({ [`PUT ${TEAM}`]: [200, { ...WS_ON, memory_enabled: false }] }));
    renderTeam(<TeamMemoryPage />);
    await userEvent.click(await box(/Allow memory in this workspace/));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText(/Site Policy still applies\. Nothing stored was deleted/);
  });

  it("shows the model Learn uses when one is available", async () => {
    stubApi(
      teamRoutes({
        [`GET ${EFFECTIVE}`]: [
          200,
          { ...EFFECTIVE_ON, learn: { available: true, alias: "big", source: "site" } },
        ],
      }),
    );
    renderTeam(<TeamMemoryPage />);
    await screen.findByText(/uses big \(the site's learning model\)/);
  });

  it("shows the server's refusal", async () => {
    stubApi(teamRoutes({ [`PUT ${TEAM}`]: [403, { code: "forbidden", message: "Not allowed." }] }));
    renderTeam(<TeamMemoryPage />);
    await userEvent.click(await box(/Allow memory in this workspace/));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Not allowed.");
  });
});

const SETTINGS = {
  learning_model_alias: null,
  embedding_model_alias: null,
  context_budget_kib: 8,
  scope_limits: { user: 1000, portable: 1000, team: 1000, site: 1000 },
  version_cap: 50,
  stale_after_days: 90,
  rate_limits: { learn_passes_per_hour: 10, saves_per_minute: 30 },
  retention_days: 365,
};
const SITE_ON = {
  memory_enabled: true,
  project_memory_enabled: true,
  memories_enabled: true,
  portable_enabled: true,
  learn_enabled: true,
  site_proposals_enabled: true,
  settings: SETTINGS,
};

describe("Site console › Settings › Memory (KOBE-381 ac-3)", () => {
  it("shows and saves every Site switch", async () => {
    const calls = stubApi({
      [`GET ${SITE}`]: [200, SITE_ON],
      [`PUT ${SITE}`]: [200, { ...SITE_ON, portable_enabled: false, learn_enabled: false }],
    });
    renderSite(<MemorySwitchesSection />);
    for (const name of [
      /Allow memory on this site/,
      /Allow project notes on this site/,
      /Allow memories on this site/,
      /Portable preferences/,
      /Learn from this chat/,
      /Members may propose to the Site/,
    ]) {
      expect(((await box(name)) as HTMLInputElement).checked).toBe(true);
    }
    await userEvent.click(await box(/Portable preferences/));
    await userEvent.click(await box(/Learn from this chat/));
    await userEvent.click(screen.getByRole("button", { name: "Save memory settings" }));
    await screen.findByText(/Memory settings saved on this site/);
    expect(putBody(calls, SITE)).toEqual({
      memory_enabled: true,
      project_memory_enabled: true,
      memories_enabled: true,
      portable_enabled: false,
      learn_enabled: false,
      site_proposals_enabled: true,
    });
  });

  it("persists the master switch", async () => {
    const calls = stubApi({
      [`GET ${SITE}`]: [200, SITE_ON],
      [`PUT ${SITE}`]: [200, { ...SITE_ON, memory_enabled: false }],
    });
    renderSite(<MemorySwitchesSection />);
    await userEvent.click(await box(/Allow memory on this site/));
    await userEvent.click(screen.getByRole("button", { name: "Save memory settings" }));
    await screen.findByText(/Memory is off on this site/);
    expect(putBody(calls, SITE)).toMatchObject({ memory_enabled: false });
  });

  it("shows and saves the Site memory settings; no search language setting", async () => {
    const calls = stubApi({
      [`GET ${SITE}`]: [200, SITE_ON],
      [`PUT ${SITE}`]: [200, SITE_ON],
    });
    renderSite(<MemorySwitchesSection />);
    const budget = await screen.findByRole("textbox", { name: /Context budget \(KiB, 4 to 16\)/ });
    expect((budget as HTMLInputElement).value).toBe("8");
    for (const [name, value] of [
      [/Versions kept per memory/, "50"],
      [/Stale after \(days\)/, "90"],
      [/Site retention window \(days\)/, "365"],
      [/Memories per person in a workspace/, "1000"],
      [/Learning passes per person per hour/, "10"],
      [/Memory saves per person per minute/, "30"],
    ] as const) {
      expect((screen.getByRole("textbox", { name }) as HTMLInputElement).value).toBe(value);
    }
    expect(screen.queryByRole("textbox", { name: /language/i })).toBeNull();
    await userEvent.clear(budget);
    await userEvent.type(budget, "12");
    await userEvent.type(
      screen.getByRole("textbox", { name: /Learning model \(model alias\)/ }),
      "big",
    );
    await userEvent.click(screen.getByRole("button", { name: "Save site memory settings" }));
    await screen.findByText("Site memory settings saved.");
    expect(putBody(calls, SITE)).toEqual({
      settings: { ...SETTINGS, context_budget_kib: 12, learning_model_alias: "big" },
    });
  });

  it("M1: a removed Site model is flagged 'choose another' and doesn't block saving", async () => {
    const stale = {
      ...SITE_ON,
      settings: { ...SETTINGS, learning_model_alias: "gone" },
      removed_models: ["learning_model_alias"],
    };
    const calls = stubApi({ [`GET ${SITE}`]: [200, stale], [`PUT ${SITE}`]: [200, stale] });
    renderSite(<MemorySwitchesSection />);
    await screen.findByText(/Removed from the site's models — choose another/);
    const retention = screen.getByRole("textbox", { name: /Site retention window/ });
    await userEvent.clear(retention);
    await userEvent.type(retention, "400");
    await userEvent.click(screen.getByRole("button", { name: "Save site memory settings" }));
    await screen.findByText("Site memory settings saved.");
    expect(putBody(calls, SITE)).toMatchObject({ settings: { retention_days: 400 } });
  });

  it("refuses a context budget outside 4 to 16 KiB before sending", async () => {
    const calls = stubApi({ [`GET ${SITE}`]: [200, SITE_ON] });
    renderSite(<MemorySwitchesSection />);
    const budget = await screen.findByRole("textbox", { name: /Context budget/ });
    await userEvent.clear(budget);
    await userEvent.type(budget, "32");
    await userEvent.click(screen.getByRole("button", { name: "Save site memory settings" }));
    await screen.findByText("The context budget must be a whole number from 4 to 16.");
    expect(calls.filter((c) => c.method === "PUT")).toEqual([]);
  });
});
