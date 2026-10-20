// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"disableIframePageLoading":true,"handleDisabledFileLoadingAsSuccess":true},"width":1280,"height":800}
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { must } from "../../lib/testing/must";
import { agentChoices, chatRequests, composer, openApp } from "./testing";

/**
 * KOBE-451: the composer's + menu. Attach files, Connectors (on or off for this thread, a broken
 * one with its reason and fix), Memory (a placeholder), Skills (a removable chip sent with the
 * message) and Apps (an app card, as from the rail).
 */
let fake: FakeKobe;
const WAIT = { timeout: 10_000 };
const KEYED = "11111111-1111-4111-8111-111111111111";
const BARE = "22222222-2222-4222-8222-222222222222";
const APP = {
  appId: "a".repeat(64),
  connectorId: KEYED,
  connectorName: "Catalyst",
  iconUrl: null,
  tool: "open_lakehouse_explorer",
  title: "Lakehouse Explorer",
  uri: "ui://catalyst/lakehouse-explorer",
  sha256: "e".repeat(64),
};

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  fake = new FakeKobe();
  fake.chatConnectors.push(
    { connector_id: KEYED, name: "catalyst", problem: null },
    {
      connector_id: BARE,
      name: "github",
      problem: {
        code: "no_key",
        message: "Add your API key for this server.",
        fix: { href: "/me/connectors", label: "My connector keys" },
      },
    },
  );
  fake.chatSkills.push("pdf-report", "pretty-html");
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

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function answered() {
  const t = fake.addThread("Tables");
  const u = fake.addEntry(t, null, { role: "user", content: "hello" });
  fake.addEntry(t, u, { role: "assistant", content: [{ type: "text", text: "hi" }] });
  return t;
}

const plus = () => screen.findByRole("button", { name: "Add to your message" }, WAIT);
async function openMenu() {
  const user = userEvent.setup();
  (await plus()).focus();
  await user.keyboard("{Enter}");
  const menu = await screen.findByRole("menu", {}, WAIT);
  return { user, menu };
}
async function openSub(name: string) {
  const { user, menu } = await openMenu();
  within(menu)
    .getByRole("menuitem", { name: new RegExp(`^${name}`) })
    .focus();
  await user.keyboard("{ArrowRight}");
  return { user, sub: await screen.findByRole("menu", { name }, WAIT) };
}
const posts = (end: string) => chatRequests(fake, "POST").filter((r) => r.path.endsWith(end));

describe("the + menu (ac-1)", { timeout: 30_000 }, () => {
  it("replaces the attach icon: Attach files, Connectors, Memory (soon), Skills, Apps", async () => {
    openApp(fake, answered());
    await composer();
    expect(screen.queryByRole("button", { name: "Attach files" })).toBeNull();
    const { user, menu } = await openMenu();
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((i) => i.textContent),
    ).toEqual(["Attach files", "Connectors", "MemoryComing soon", "Skills", "Apps"]);
    const memory = within(menu).getByRole("menuitem", { name: /^Memory/ });
    expect(memory.getAttribute("aria-disabled")).toBe("true");
    const picker = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {});
    await user.click(within(menu).getByRole("menuitem", { name: "Attach files" }));
    expect(picker).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it("Escape closes it and gives the focus back to the button", async () => {
    openApp(fake, answered());
    const { user } = await openMenu();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(document.activeElement).toBe(await plus());
  });
});

describe("Connectors (ac-2, ac-3, ac-6)", { timeout: 30_000 }, () => {
  it("toggles a working one for this thread; a broken one shows its reason and fix, no toggle", async () => {
    const t = answered();
    openApp(fake, t);
    const { user, sub } = await openSub("Connectors");
    const on = await within(sub).findByRole("menuitemcheckbox", { name: /catalyst/ }, WAIT);
    expect(on.getAttribute("aria-checked")).toBe("true");
    const broken = within(sub).getByRole("menuitem", { name: /github/ });
    expect(broken.textContent).toContain("Add your API key for this server.");
    expect(broken.textContent).toContain("My connector keys");
    expect(within(broken).getByLabelText("Not working")).toBeTruthy();
    expect(within(sub).queryByRole("menuitemcheckbox", { name: /github/ })).toBeNull();
    await user.click(on);
    await waitFor(() => expect(on.getAttribute("aria-checked")).toBe("false"));
    const put = chatRequests(fake, "PUT").find((r) => r.path.includes("/connectors/"));
    expect(put).toMatchObject({
      path: `/v1/threads/${t}/connectors/${KEYED}`,
      body: { enabled: false },
    });
    expect(fake.connectorsOff.get(t)).toEqual(new Set([KEYED]));
  });

  it("a new conversation's toggles go with its creation (review MEDIUM-3)", async () => {
    openApp(fake);
    const { user, sub } = await openSub("Connectors");
    const on = await within(sub).findByRole("menuitemcheckbox", { name: /catalyst/ }, WAIT);
    expect(on.getAttribute("aria-disabled")).toBeNull();
    await user.click(on);
    await waitFor(() => expect(on.getAttribute("aria-checked")).toBe("false"));
    expect(chatRequests(fake, "PUT")).toEqual([]);
    await user.keyboard("{Escape}");
    await user.type(await composer(), "first{Enter}");
    await waitFor(() => expect(posts("/messages")).toHaveLength(1));
    const created = chatRequests(fake, "POST").find((r) => r.path === "/v1/threads");
    expect(created?.body).toMatchObject({ connectors_off: [KEYED] });
  });

  it("an app whose connector is off here is not offered (review LOW-5)", async () => {
    fake.teamApps = [APP];
    const t = answered();
    fake.connectorsOff.set(t, new Set([KEYED]));
    openApp(fake, t);
    const { sub } = await openSub("Apps");
    expect(await within(sub).findByText("No apps for you here.", {}, WAIT)).toBeTruthy();
    expect(within(sub).queryByRole("menuitem", { name: /Lakehouse Explorer/ })).toBeNull();
  });
});

describe("a message sent with a skill (review MEDIUM-2)", { timeout: 30_000 }, () => {
  const LINE =
    'Use the skill "pdf-report" for this message: read its SKILL.md first and follow it.\n\n';
  function skilled() {
    const t = fake.addThread("Skilled");
    const root = fake.addSystemEntry(t, null, "model_change", {
      provider: "kobe",
      modelId: "kimi",
    });
    const u = fake.addEntry(t, root, { role: "user", content: `${LINE}Q3 report` });
    fake.addEntry(t, u, { role: "assistant", content: [{ type: "text", text: "done" }] });
    return { t, root };
  }

  it("regenerate sends the same text with the same skill", async () => {
    const { t, root } = skilled();
    openApp(fake, t);
    await screen.findByText("done", {}, WAIT);
    await userEvent.setup().click(must(screen.getAllByRole("button", { name: "Regenerate" })[0]));
    await waitFor(() =>
      expect(must(posts("/messages")[0]).body).toEqual({
        content: "Q3 report",
        parent_entry_id: root,
        skill: "pdf-report",
      }),
    );
  });

  it("edit keeps the skill as a chip; removing the chip sends none", async () => {
    const { t, root } = skilled();
    openApp(fake, t);
    await screen.findByText("done", {}, WAIT);
    const user = userEvent.setup();
    await user.click(must(screen.getAllByRole("button", { name: "Edit" })[0]));
    const editor = await screen.findByLabelText("Edit your message");
    expect((editor as HTMLTextAreaElement).value).toBe("Q3 report");
    expect(document.querySelector('[data-kobe-edit-skill="pdf-report"]')).not.toBeNull();
    await user.type(editor, " for Berlin");
    await user.click(within(must(editor.closest("form"))).getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(must(posts("/messages")[0]).body).toEqual({
        content: "Q3 report for Berlin",
        parent_entry_id: root,
        skill: "pdf-report",
      }),
    );
  });

  it("edit without the chip sends no skill", async () => {
    const { t, root } = skilled();
    openApp(fake, t);
    await screen.findByText("done", {}, WAIT);
    const user = userEvent.setup();
    await user.click(must(screen.getAllByRole("button", { name: "Edit" })[0]));
    const editor = await screen.findByLabelText("Edit your message");
    await user.click(screen.getByRole("button", { name: "Remove the skill pdf-report" }));
    await user.click(within(must(editor.closest("form"))).getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(must(posts("/messages")[0]).body).toEqual({
        content: "Q3 report",
        parent_entry_id: root,
      }),
    );
  });
});

describe("Skills (ac-4)", { timeout: 30_000 }, () => {
  it("a picked skill is a removable chip and goes with the message, once", async () => {
    const t = answered();
    openApp(fake, t);
    const { user, sub } = await openSub("Skills");
    await user.click(await within(sub).findByRole("menuitem", { name: "pdf-report" }, WAIT));
    const chip = await waitFor(() =>
      must(document.querySelector<HTMLElement>('[data-kobe-skill-chip="pdf-report"]')),
    );
    expect(chip.textContent).toContain("Skill: pdf-report");
    await user.type(await composer(), "Q3 report{Enter}");
    await waitFor(() => expect(posts("/messages")).toHaveLength(1));
    expect(must(posts("/messages")[0]).body).toMatchObject({
      content: "Q3 report",
      skill: "pdf-report",
    });
    await waitFor(() => expect(document.querySelector("[data-kobe-skill-chip]")).toBeNull());
  });

  it("× removes the chip: nothing is asked of the run", async () => {
    openApp(fake, answered());
    const { user, sub } = await openSub("Skills");
    await user.click(await within(sub).findByRole("menuitem", { name: "pretty-html" }, WAIT));
    await user.click(await screen.findByRole("button", { name: "Remove the skill pretty-html" }));
    expect(document.querySelector("[data-kobe-skill-chip]")).toBeNull();
  });

  it("a sent message shows its skill as a chip in the history", async () => {
    const t = fake.addThread("Skilled");
    const u = fake.addEntry(t, null, {
      role: "user",
      content:
        'Use the skill "pdf-report" for this message: read its SKILL.md first and follow it.\n\nQ3 report',
    });
    fake.addEntry(t, u, { role: "assistant", content: [{ type: "text", text: "done" }] });
    openApp(fake, t);
    const sent = await waitFor(
      () => must(document.querySelector<HTMLElement>('[data-kobe-sent-skill="pdf-report"]')),
      WAIT,
    );
    expect(sent.textContent).toBe("Skill: pdf-report");
    expect(screen.getByText("Q3 report")).toBeTruthy();
    expect(screen.queryByText(/read its SKILL\.md/)).toBeNull();
  });
});

describe("Apps (ac-7)", { timeout: 30_000 }, () => {
  it("lists the rail's apps and launches one into this thread as a card, like the rail", async () => {
    fake.teamApps = [APP];
    const t = answered();
    openApp(fake, t);
    const { user, sub } = await openSub("Apps");
    await user.click(
      await within(sub).findByRole("menuitem", { name: /Lakehouse Explorer/ }, WAIT),
    );
    await waitFor(() =>
      expect(posts("/app-cards").map((r) => r.path)).toEqual([`/v1/threads/${t}/app-cards`]),
    );
    expect(must(posts("/app-cards")[0]).body).toEqual({ app_id: APP.appId });
    expect(posts("/messages")).toEqual([]);
  });

  it("from a new conversation the app starts a new thread", async () => {
    fake.teamApps = [APP];
    openApp(fake);
    const { user, sub } = await openSub("Apps");
    await user.click(
      await within(sub).findByRole("menuitem", { name: /Lakehouse Explorer/ }, WAIT),
    );
    await waitFor(() =>
      expect(posts("/app-cards").map((r) => r.path)).toEqual(["/v1/threads/app-cards"]),
    );
    // Untouched choices: the server applies the default agent; nothing is off.
    expect(must(posts("/app-cards")[0]).body).toEqual({ app_id: APP.appId });
  });

  it("from a new conversation the launch carries the agent and connectors chosen there (KOBE-458)", async () => {
    fake.teamApps = [APP];
    fake.runnableAgents.push({
      id: "a-kobe",
      scope: "gallery",
      galleryKey: "kobe",
      default: true,
      name: "Kobe",
      model: null,
    });
    openApp(fake);
    const user = userEvent.setup();
    await waitFor(async () =>
      expect(
        (within(await agentChoices()).getByRole("radio", { name: /Kobe/ }) as HTMLInputElement)
          .checked,
      ).toBe(true),
    );
    await user.click(within(await agentChoices()).getByRole("radio", { name: /No agent/ }));
    await user.keyboard("{Escape}");
    const connectors = await openSub("Connectors");
    await connectors.user.click(
      await within(connectors.sub).findByRole("menuitemcheckbox", { name: /catalyst/ }, WAIT),
    );
    await connectors.user.keyboard("{Escape}");
    const { sub } = await openSub("Apps");
    await user.click(
      await within(sub).findByRole("menuitem", { name: /Lakehouse Explorer/ }, WAIT),
    );
    await waitFor(() => expect(posts("/app-cards")).toHaveLength(1));
    expect(must(posts("/app-cards")[0]).body).toEqual({
      app_id: APP.appId,
      agent_id: null,
      connectors_off: [KEYED],
    });
  });
});
