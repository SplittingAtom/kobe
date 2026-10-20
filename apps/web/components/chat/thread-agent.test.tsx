// @vitest-environment happy-dom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { must } from "../../lib/testing/must";
import { agentChoices, chatRequests, composer, openApp } from "./testing";

/**
 * KOBE-458 ac-3: a started conversation with no agent (one a rail launch started before the fix)
 * keeps the Agent picker; choosing gives the thread that agent through `POST /agent`, and the
 * fixed chip then names it. A thread with an agent keeps today's chip; the chip never names the
 * draft's default for a thread that has no agent.
 */
let fake: FakeKobe;
const KOBE = {
  id: "aaaaaaaa-0000-4000-8000-0000000000k0",
  scope: "gallery",
  galleryKey: "kobe",
  default: true,
  name: "Kobe",
  model: null,
} as const;

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  fake = new FakeKobe();
  fake.runnableAgents.push(KOBE);
  vi.stubGlobal("fetch", fake.fetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const header = async () => screen.findByRole("heading", { level: 2, name: "Lakehouse Picker" });
const chooses = () => chatRequests(fake, "POST").filter((r) => r.path.endsWith("/agent"));

describe("an agentless started thread takes an agent (KOBE-458 ac-3)", () => {
  it("offers the picker, sends the choice, then shows the chosen agent's chip", async () => {
    const t = fake.addThread("Lakehouse Picker");
    openApp(fake, t);
    await header();
    const user = userEvent.setup();
    expect(await screen.findByRole("button", { name: /Chat with: No agent/ })).toBeTruthy();
    await user.click(within(await agentChoices()).getByRole("radio", { name: /Kobe/ }));
    await waitFor(() => expect(chooses()).toHaveLength(1));
    expect(must(chooses()[0]).body).toEqual({ agent_id: KOBE.id });
    expect(await screen.findByText("Agent: Kobe")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Chat with:/ })).toBeNull();
    expect(must(fake.threads.get(t)).agent_id).toBe(KOBE.id);
    await composer();
  });

  it("keeps the fixed chip for a thread that has an agent", async () => {
    const t = fake.addThread("Lakehouse Picker");
    Object.assign(must(fake.threads.get(t)), {
      agent_id: KOBE.id,
      agent_name: "Kobe",
      agent_status: "active",
      agent_version: 1,
    });
    openApp(fake, t);
    await header();
    expect(await screen.findByText("Agent: Kobe")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Chat with:/ })).toBeNull();
  });
});
