// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"disableIframePageLoading":true,"handleDisabledFileLoadingAsSuccess":true},"width":1280,"height":800}
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { must } from "../../lib/testing/must";
import { chatRequests, composer, openApp, streaming } from "../chat/testing";

/**
 * KOBE-440 (MA-6, spec MA3, MA8, MA11): the rail's Apps section lists the member's apps and
 * launches one into the conversation as an app card (no run); from the new-thread view a launch
 * starts a thread; during a run it waits as a removable chip; an app missing only the member's
 * key shows "Add your key".
 */
let fake: FakeKobe;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  fake = new FakeKobe();
  vi.stubGlobal("fetch", fake.fetch);
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(private readonly cb: IntersectionObserverCallback) {}
      observe(target: Element) {
        this.cb([{ isIntersecting: true, target } as IntersectionObserverEntry], this as never);
      }
      disconnect() {}
      unobserve() {}
    },
  );
});

const APP = {
  appId: "a".repeat(64),
  connectorId: "11111111-1111-4111-8111-111111111111",
  connectorName: "Catalyst",
  iconUrl: null,
  tool: "open_lakehouse_explorer",
  title: "Lakehouse Explorer",
  uri: "ui://catalyst/lakehouse-explorer",
  sha256: "e".repeat(64),
};
const FRAME = "Lakehouse Explorer (app from Catalyst)";

function answered() {
  const t = fake.addThread("Tables");
  const u = fake.addEntry(t, null, { role: "user", content: "hello" });
  fake.addEntry(t, u, { role: "assistant", content: [{ type: "text", text: "hi" }] });
  return t;
}

const appsSection = () => screen.findByRole("region", { name: "Apps" });
const launches = () => chatRequests(fake, "POST").filter((r) => r.path.endsWith("/app-cards"));
const messages = () => chatRequests(fake, "POST").filter((r) => r.path.endsWith("/messages"));

describe("app cards in the conversation (KOBE-440)", () => {
  it("renders a launched card with its app, under a header saying the member opened it", async () => {
    const t = answered();
    fake.addAppCard(t, APP);
    openApp(fake, t);
    const card = await waitFor(() => must(document.querySelector("[data-kobe-app-card-entry]")), {
      timeout: 4_000,
    });
    await waitFor(() =>
      expect(card.textContent).toContain("You opened Lakehouse Explorer from Catalyst"),
    );
    await waitFor(() => expect(within(card as HTMLElement).getByTitle(FRAME)).toBeTruthy());
  });

  it("shows the text card's reason to a viewer who gets text", async () => {
    const t = answered();
    fake.addAppCard(t, APP);
    fake.appResults.set(
      t,
      (fake.appResults.get(t) ?? []).map((v) => ({ ...v, view: "text", reason: "no_access" })),
    );
    openApp(fake, t);
    expect(await screen.findByText("Connect Catalyst to use this app.")).toBeTruthy();
    expect(screen.queryByTitle(FRAME)).toBeNull();
  });
});

describe("the rail's Apps section (KOBE-440)", () => {
  it("launches an app into the current thread as a card, with no message and no run (ac-2)", async () => {
    fake.teamApps = [APP];
    const t = answered();
    openApp(fake, t);
    const section = await appsSection();
    const user = userEvent.setup();
    await user.click(
      within(section).getByRole("button", { name: "Open Lakehouse Explorer in this conversation" }),
    );
    await waitFor(() =>
      expect(launches().map((r) => r.path)).toEqual([`/v1/threads/${t}/app-cards`]),
    );
    expect(must(launches()[0]).body).toEqual({ app_id: APP.appId });
    await waitFor(() => expect(screen.getByTitle(FRAME)).toBeTruthy(), { timeout: 4_000 });
    expect(messages()).toEqual([]);
    expect(fake.activeRun(t)).toBeUndefined();
  });

  it("starts a new thread with the card from the new-thread view (ac-2)", async () => {
    fake.teamApps = [APP];
    openApp(fake);
    const section = await appsSection();
    await userEvent
      .setup()
      .click(within(section).getByRole("button", { name: /Open Lakehouse Explorer/ }));
    await waitFor(() => expect(launches().map((r) => r.path)).toEqual(["/v1/threads/app-cards"]));
    await waitFor(() => expect(screen.getByTitle(FRAME)).toBeTruthy(), { timeout: 4_000 });
  });

  it("queues a launch during a run as a removable chip; the run's end inserts it (ac-4)", async () => {
    fake.teamApps = [APP];
    const t = answered();
    openApp(fake, t);
    const user = userEvent.setup();
    await user.type(await composer(), "first{Enter}");
    await waitFor(() => expect(fake.activeRun(t)).toBeDefined());
    const runId = must(fake.activeRun(t)).run_id;
    await streaming(fake, runId);
    const open = within(await appsSection()).getByRole("button", {
      name: /Open Lakehouse Explorer/,
    });
    await user.click(open);
    expect(await screen.findByText("App: Lakehouse Explorer (waits for the run)")).toBeTruthy();
    // Removing the chip cancels it.
    await user.click(
      screen.getByRole("button", { name: "Remove Lakehouse Explorer from the queue" }),
    );
    await waitFor(() =>
      expect(screen.queryByText("App: Lakehouse Explorer (waits for the run)")).toBeNull(),
    );
    expect(chatRequests(fake, "DELETE").some((r) => r.path.includes("/app-cards/"))).toBe(true);
    // A second launch waits, and appears as a card when the run ends.
    await user.click(open);
    expect(await screen.findByText("App: Lakehouse Explorer (waits for the run)")).toBeTruthy();
    fake.agent.commitPrompt(runId);
    fake.agent.commit(runId, { role: "assistant", content: [{ type: "text", text: "one" }] });
    fake.agent.complete(runId);
    await waitFor(() => expect(screen.getByTitle(FRAME)).toBeTruthy(), { timeout: 4_000 });
    await waitFor(() =>
      expect(screen.queryByText("App: Lakehouse Explorer (waits for the run)")).toBeNull(),
    );
  });

  it("is absent without apps, and says 'Add your key' when only the member's key is missing (ac-1)", async () => {
    openApp(fake, answered());
    await screen.findByLabelText("Message");
    expect(screen.queryByRole("region", { name: "Apps" })).toBeNull();
    cleanup();
    fake.teamAppsNeedKey = [
      { connectorId: APP.connectorId, connectorName: "Catalyst", title: "Lakehouse Explorer" },
    ];
    openApp(fake, answered());
    const section = await appsSection();
    const link = within(section).getByRole("link", { name: /Add your key/ });
    expect(link.getAttribute("href")).toBe("/me/connectors");
    expect(section.textContent).toContain("Catalyst");
    expect(within(section).queryByRole("button", { name: /Open Lakehouse Explorer/ })).toBeNull();
  });
});
