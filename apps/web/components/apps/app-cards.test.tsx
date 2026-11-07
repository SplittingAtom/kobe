// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"disableIframePageLoading":true,"handleDisabledFileLoadingAsSuccess":true},"width":1280,"height":800}
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { must } from "../../lib/testing/must";
import { DESKTOP_WIDTH, resizeWindow } from "../../lib/testing/viewport";
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
  resizeWindow(DESKTOP_WIDTH);
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

/** The rail's Apps tab (KOBE-448: beside Files), chosen. */
async function appsSection(): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole("tab", { name: "Apps" }));
  return screen.findByRole("tabpanel", { name: "Apps" });
}

/**
 * Launches Lakehouse Explorer from the composer's + menu (KOBE-451), the one launcher since the
 * rail lists no apps (KOBE-559): Add to your message, Apps, the app.
 */
async function launchViaPlus(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  (await screen.findByRole("button", { name: "Add to your message" })).focus();
  await user.keyboard("{Enter}");
  const menu = await screen.findByRole("menu", {}, { timeout: 4_000 });
  within(menu).getByRole("menuitem", { name: /^Apps/ }).focus();
  await user.keyboard("{ArrowRight}");
  const sub = await screen.findByRole("menu", { name: "Apps" }, { timeout: 4_000 });
  await user.click(
    await within(sub).findByRole("menuitem", { name: /Lakehouse Explorer/ }, { timeout: 4_000 }),
  );
}

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

describe("the rail's Apps section (KOBE-440; no app list since KOBE-559)", () => {
  it("queues a launch during a run as a removable chip; the run's end inserts it (ac-4)", async () => {
    fake.teamApps = [APP];
    const t = answered();
    openApp(fake, t);
    const user = userEvent.setup();
    await user.type(await composer(), "first{Enter}");
    await waitFor(() => expect(fake.activeRun(t)).toBeDefined());
    const runId = must(fake.activeRun(t)).run_id;
    await streaming(fake, runId);
    await launchViaPlus(user);
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
    await launchViaPlus(user);
    expect(await screen.findByText("App: Lakehouse Explorer (waits for the run)")).toBeTruthy();
    fake.agent.commitPrompt(runId);
    fake.agent.commit(runId, { role: "assistant", content: [{ type: "text", text: "one" }] });
    fake.agent.complete(runId);
    await waitFor(() => expect(screen.getByTitle(FRAME)).toBeTruthy(), { timeout: 4_000 });
    await waitFor(() =>
      expect(screen.queryByText("App: Lakehouse Explorer (waits for the run)")).toBeNull(),
    );
  });

  it("shows a waiting card the server inserts after the run's end was read (KOBE-415)", async () => {
    // The server ends the run, then inserts its waiting cards in a later transaction: the reads
    // that follow the end can see the run ended and the card still waiting.
    fake.teamApps = [APP];
    fake.deferCardInsertion = true;
    const t = answered();
    openApp(fake, t);
    const user = userEvent.setup();
    await user.type(await composer(), "first{Enter}");
    await waitFor(() => expect(fake.activeRun(t)).toBeDefined());
    const runId = must(fake.activeRun(t)).run_id;
    await streaming(fake, runId);
    await launchViaPlus(user);
    expect(await screen.findByText("App: Lakehouse Explorer (waits for the run)")).toBeTruthy();
    fake.agent.commitPrompt(runId);
    fake.agent.commit(runId, { role: "assistant", content: [{ type: "text", text: "one" }] });
    fake.agent.complete(runId);
    await waitFor(() => expect(screen.getByText("one")).toBeTruthy());
    await new Promise((r) => setTimeout(r, 300)); // the reads after the end have answered
    fake.insertWaitingCards(t);
    await waitFor(() => expect(screen.getByTitle(FRAME)).toBeTruthy(), { timeout: 6_000 });
    expect(screen.queryByText("App: Lakehouse Explorer (waits for the run)")).toBeNull();
    expect(screen.queryByText(/Not added to the conversation/)).toBeNull();
  });

  it("says when the server dropped a waiting card at the run's end (review LOW-2)", async () => {
    fake.teamApps = [APP];
    fake.dropWaitingCards = true;
    const t = answered();
    openApp(fake, t);
    const user = userEvent.setup();
    await user.type(await composer(), "first{Enter}");
    await waitFor(() => expect(fake.activeRun(t)).toBeDefined());
    const runId = must(fake.activeRun(t)).run_id;
    await streaming(fake, runId);
    await launchViaPlus(user);
    expect(await screen.findByText("App: Lakehouse Explorer (waits for the run)")).toBeTruthy();
    fake.agent.commitPrompt(runId);
    fake.agent.commit(runId, { role: "assistant", content: [{ type: "text", text: "one" }] });
    fake.agent.complete(runId);
    expect(
      await screen.findByText(/Not added to the conversation: Lakehouse Explorer/),
    ).toBeTruthy();
    expect(screen.queryByTitle(FRAME)).toBeNull();
  });

  it("is absent without apps, and says 'Add your key' when only the member's key is missing (ac-1)", async () => {
    openApp(fake, answered());
    await screen.findByLabelText("Message");
    // KOBE-448: no Apps tab and no tablist; the section is Files alone.
    expect(screen.queryByRole("tab", { name: "Apps" })).toBeNull();
    expect(screen.queryByRole("tablist")).toBeNull();
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
