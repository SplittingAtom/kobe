// @vitest-environment happy-dom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { must } from "../../lib/testing/must";
import { agentChoices, chatRequests, composer, openApp } from "./testing";

/**
 * KOBE-122: choosing an agent for a new conversation. The list is the server's runnable set
 * (suspended and archived agents are never in it); a pinned model locks the model picker.
 */
let fake: FakeKobe;

beforeEach(() => {
  sessionStorage.clear();
  fake = new FakeKobe();
  fake.teamModels.push(
    { alias: "kimi", label: "Kimi K2.7 Code", enabled: true, is_default: true },
    { alias: "glm", label: "GLM 5.3", enabled: true, is_default: false },
  );
  fake.runnableAgents.push(
    {
      id: "a-ledger",
      scope: "team",
      name: "Ledger Bot",
      description: "Reconciles books",
      model: null,
    },
    {
      id: "a-pinned",
      scope: "gallery",
      name: "Pinned Bot",
      description: "Always GLM",
      model: "glm",
    },
    { id: "a-mine", scope: "personal", name: "My Helper", model: null },
  );
  vi.stubGlobal("fetch", fake.fetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const group = agentChoices;
const modelSelect = () =>
  screen.findByRole("combobox", {
    name: "Model for this conversation",
  }) as Promise<HTMLSelectElement>;

describe("agent picker", () => {
  it("lists No agent (selected) and the runnable agents with description and pinned model", async () => {
    openApp(fake);
    const radios = within(await group()).getAllByRole("radio") as HTMLInputElement[];
    expect(radios.map((r) => r.closest("label")?.textContent)).toEqual([
      "No agentA plain conversation",
      "Ledger BotTeamReconciles books",
      "Pinned BotBuilt-inAlways GLMModel: GLM 5.3",
      "My HelperPersonal",
    ]);
    expect(radios[0]?.checked).toBe(true);
    const read = fake.requests.find((r) => r.path.startsWith("/v1/agents/runnable"));
    expect(read?.team).toBe(fake.teamId);
  });

  it("KOBE-297: shows each agent's origin and tells equal names apart", async () => {
    fake.runnableAgents.length = 0;
    fake.runnableAgents.push(
      {
        id: "g-kobe",
        scope: "gallery",
        galleryKey: "kobe",
        default: true,
        slug: "kobe",
        name: "Kobe",
        model: null,
      },
      { id: "t-kobe", scope: "team", slug: "kobe-team1", name: "Kobe", model: null },
      { id: "t-ops", scope: "team", slug: "kobe-ops", name: "Kobe", model: null },
      { id: "p-kobe", scope: "personal", slug: "kobe-mine", name: "Kobe", model: null },
      { id: "t-solo", scope: "team", slug: "solo", name: "Solo", model: null },
    );
    openApp(fake);
    const radios = within(await group()).getAllByRole("radio") as HTMLInputElement[];
    expect(radios.map((r) => r.closest("label")?.textContent)).toEqual([
      "No agentA plain conversation",
      "KobeBuilt-in",
      "KobeTeamkobe-team1",
      "KobeTeamkobe-ops",
      "KobePersonal",
      "SoloTeam",
    ]);
    // Screen readers hear the origin with the name, and the slug where the origin is shared.
    expect(within(await group()).getByRole("radio", { name: "Kobe, Built-in" })).toBeTruthy();
    expect(within(await group()).getByRole("radio", { name: "Kobe, Team, kobe-ops" })).toBeTruthy();
    const user = userEvent.setup();
    await user.click(within(await group()).getByRole("radio", { name: "Kobe, Team, kobe-team1" }));
    expect(
      await screen.findByRole("button", { name: "Chat with: Kobe (Team, kobe-team1)" }),
    ).toBeTruthy();
    await user.click(within(await group()).getByRole("radio", { name: "Solo, Team" }));
    expect(await screen.findByRole("button", { name: "Chat with: Solo" })).toBeTruthy();
  });

  it("starts a plain conversation by default", async () => {
    openApp(fake);
    await group();
    await userEvent.setup().type(await composer(), "hello{Enter}");
    await waitFor(() => expect(fake.threads.size).toBe(1));
    expect(must(chatRequests(fake, "POST")[0]).body).not.toHaveProperty("agent_id");
  });

  it("creates the conversation with the chosen agent and shows its name in the header", async () => {
    openApp(fake);
    const user = userEvent.setup();
    await user.click(within(await group()).getByRole("radio", { name: /Ledger Bot/ }));
    await user.type(await composer(), "reconcile{Enter}");
    await waitFor(() => expect(fake.threads.size).toBe(1));
    expect(chatRequests(fake, "POST")[0]).toMatchObject({
      path: "/v1/threads",
      body: { agent_id: "a-ledger" },
    });
    expect(await screen.findByText("Agent: Ledger Bot")).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("radiogroup")).toBeNull());
  });

  it("is keyboard operable: focus a radio and press Space", async () => {
    openApp(fake);
    const user = userEvent.setup();
    const mine = within(await group()).getByRole("radio", { name: /My Helper/ });
    mine.focus();
    await user.keyboard(" ");
    expect((mine as HTMLInputElement).checked).toBe(true);
  });

  it("disables the model picker for an agent with a pinned model and sends no model", async () => {
    openApp(fake);
    const user = userEvent.setup();
    const select = await modelSelect();
    await user.selectOptions(select, "kimi");
    await user.click(within(await group()).getByRole("radio", { name: /Pinned Bot/ }));
    const locked = await modelSelect();
    expect(locked.disabled).toBe(true);
    expect(locked.value).toBe("glm");
    expect(screen.getByText("This agent always uses GLM 5.3.")).toBeTruthy();
    await user.type(await composer(), "go{Enter}");
    await waitFor(() => expect(fake.threads.size).toBe(1));
    const body = must(chatRequests(fake, "POST")[0]).body;
    expect(body).toMatchObject({ agent_id: "a-pinned" });
    expect(body).not.toHaveProperty("model");
  });

  it("keeps the model picker enabled for an agent without a pinned model, and back to No agent", async () => {
    openApp(fake);
    const user = userEvent.setup();
    await user.click(within(await group()).getByRole("radio", { name: /Pinned Bot/ }));
    expect((await modelSelect()).disabled).toBe(true);
    await user.click(within(await group()).getByRole("radio", { name: /No agent/ }));
    expect((await modelSelect()).disabled).toBe(false);
    await user.click(within(await group()).getByRole("radio", { name: /Ledger Bot/ }));
    expect((await modelSelect()).disabled).toBe(false);
  });

  it("reads every page of the list", async () => {
    fake.runnablePageSize = 1;
    openApp(fake);
    expect(await within(await group()).findByRole("radio", { name: /My Helper/ })).toBeTruthy();
    expect(within(await group()).getAllByRole("radio")).toHaveLength(4);
  });

  it("offers nothing when no agent is runnable, and when the list can't be read", async () => {
    fake.runnableAgents.length = 0;
    openApp(fake);
    await composer();
    expect(screen.queryByRole("button", { name: /^Chat with:/ })).toBeNull();
    cleanup();
    fake.runnableAgents.push({ id: "x", scope: "team", name: "X", model: null });
    fake.failNext.set("GET /v1/agents/runnable", new Response("{}", { status: 503 }));
    openApp(fake);
    await composer();
    expect(screen.queryByRole("button", { name: /^Chat with:/ })).toBeNull();
  });

  it("names the agent in the header of an existing conversation, even one no longer listed", async () => {
    const t = fake.addThread("With agent");
    Object.assign(must(fake.threads.get(t)), {
      agent_id: "gone",
      agent_name: "Retired Bot",
      agent_status: "archived",
    });
    openApp(fake, t);
    expect(await screen.findByText("Agent: Retired Bot")).toBeTruthy();
    expect(screen.getByText("Archived")).toBeTruthy();
    expect(screen.queryByRole("radiogroup")).toBeNull();
  });

  it("marks a suspended agent in the header, and shows no badge for an active one", async () => {
    const t = fake.addThread("Paused");
    Object.assign(must(fake.threads.get(t)), {
      agent_id: "a-ledger",
      agent_name: "Ledger Bot",
      agent_status: "suspended",
    });
    openApp(fake, t);
    expect(await screen.findByText("Agent: Ledger Bot")).toBeTruthy();
    expect(screen.getByText("Suspended")).toBeTruthy();
    cleanup();
    must(fake.threads.get(t)).agent_status = "active";
    openApp(fake, t);
    expect(await screen.findByText("Agent: Ledger Bot")).toBeTruthy();
    expect(screen.queryByText("Suspended")).toBeNull();
  });

  it("does not offer the picker in the builder's test pane", async () => {
    const { ChatSession } = await import("../../lib/chat/session");
    const { createChatApi } = await import("../../lib/chat/api");
    const session = new ChatSession({
      teamId: fake.teamId,
      api: createChatApi(fake.teamId, fake.fetch),
      testAgentId: "a-ledger",
    });
    expect(session.testAgentId).toBe("a-ledger");
    expect(session.canChooseAgent).toBe(false);
  });
});
