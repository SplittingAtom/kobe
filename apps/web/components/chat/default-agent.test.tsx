// @vitest-environment happy-dom
import { cleanup, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { must } from "../../lib/testing/must";
import { agentChoices, chatRequests, composer, openApp } from "./testing";

/** KOBE-124, KOBE-254: new chats preselect the gallery agent Kobe (by gallery key) when it is runnable. */
let fake: FakeKobe;

const KOBE = {
  id: "a-kobe",
  scope: "gallery",
  galleryKey: "kobe",
  name: "Helper",
  model: null,
} as const;

beforeEach(() => {
  sessionStorage.clear();
  fake = new FakeKobe();
  fake.runnableAgents.push({ id: "a-team", scope: "team", name: "Kobe", model: null });
  vi.stubGlobal("fetch", fake.fetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const group = agentChoices;
const checked = async () =>
  (within(await group()).getAllByRole("radio") as HTMLInputElement[])
    .filter((r) => r.checked)
    .map((r) => r.closest("label")?.querySelector("span")?.textContent);

describe("default agent", () => {
  it("preselects the gallery agent Kobe by key, not by display name", async () => {
    fake.runnableAgents.push(KOBE);
    openApp(fake);
    await waitFor(async () => expect(await checked()).toEqual(["Helper"]));
    await userEvent.setup().type(await composer(), "hi{Enter}");
    await waitFor(() => expect(fake.threads.size).toBe(1));
    expect(must(chatRequests(fake, "POST")[0]).body).toMatchObject({ agent_id: "a-kobe" });
  });

  it("falls back to No agent when Kobe is not runnable (suspended or missing)", async () => {
    openApp(fake);
    expect(await checked()).toEqual(["No agent"]);
    await userEvent.setup().type(await composer(), "hi{Enter}");
    await waitFor(() => expect(fake.threads.size).toBe(1));
    expect(must(chatRequests(fake, "POST")[0]).body).not.toHaveProperty("agent_id");
  });

  it("lets the user change the selection back to No agent", async () => {
    fake.runnableAgents.push(KOBE);
    openApp(fake);
    const user = userEvent.setup();
    await waitFor(async () => expect(await checked()).toEqual(["Helper"]));
    await user.click(within(await group()).getByRole("radio", { name: /No agent/ }));
    expect(await checked()).toEqual(["No agent"]);
    await user.type(await composer(), "hi{Enter}");
    await waitFor(() => expect(fake.threads.size).toBe(1));
    expect(must(chatRequests(fake, "POST")[0]).body).not.toHaveProperty("agent_id");
  });
});
