// @vitest-environment happy-dom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { must } from "../../lib/testing/must";
import { chatRequests, composer, openApp } from "./testing";

/** KOBE-124: new chats preselect the gallery Assistant (by gallery key) when it is runnable. */
let fake: FakeKobe;

const ASSISTANT = {
  id: "a-assistant",
  scope: "gallery",
  galleryKey: "assistant",
  name: "Helper",
  model: null,
} as const;

beforeEach(() => {
  sessionStorage.clear();
  fake = new FakeKobe();
  fake.runnableAgents.push({ id: "a-team", scope: "team", name: "Assistant", model: null });
  vi.stubGlobal("fetch", fake.fetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const group = () => screen.findByRole("radiogroup", { name: "Chat with" });
const checked = async () =>
  (within(await group()).getAllByRole("radio") as HTMLInputElement[])
    .filter((r) => r.checked)
    .map((r) => r.closest("label")?.querySelector("span")?.textContent);

describe("default agent", () => {
  it("preselects the gallery Assistant by key, not by display name", async () => {
    fake.runnableAgents.push(ASSISTANT);
    openApp(fake);
    await waitFor(async () => expect(await checked()).toEqual(["Helper"]));
    await userEvent.setup().type(await composer(), "hi{Enter}");
    await waitFor(() => expect(fake.threads.size).toBe(1));
    expect(must(chatRequests(fake, "POST")[0]).body).toMatchObject({ agent_id: "a-assistant" });
  });

  it("falls back to No agent when the Assistant is not runnable (suspended or missing)", async () => {
    openApp(fake);
    expect(await checked()).toEqual(["No agent"]);
    await userEvent.setup().type(await composer(), "hi{Enter}");
    await waitFor(() => expect(fake.threads.size).toBe(1));
    expect(must(chatRequests(fake, "POST")[0]).body).not.toHaveProperty("agent_id");
  });

  it("lets the user change the selection back to No agent", async () => {
    fake.runnableAgents.push(ASSISTANT);
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
