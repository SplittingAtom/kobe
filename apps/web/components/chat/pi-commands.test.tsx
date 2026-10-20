// @vitest-environment happy-dom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { must } from "../../lib/testing/must";
import { chatRequests, composer, openApp } from "./testing";

/**
 * KOBE-450 ac-3/ac-6: the commands Kobe adds for Pi's built-ins (/thinking, /session, /export),
 * Pi's words Kobe names differently (/name offers /rename), and the ones Kobe doesn't offer: a
 * disabled row with the reason, and nothing is sent.
 */
let fake: FakeKobe;
const WAIT = { timeout: 10_000 };

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  fake = new FakeKobe();
  fake.teamModels.push(
    { alias: "kimi", label: "Kimi K2.7 Code", enabled: true, is_default: true },
    {
      alias: "glm",
      label: "GLM 5.3",
      enabled: true,
      is_default: false,
      thinking_in_team: { default: "low", levels: ["off", "low", "medium"] },
    },
  );
  fake.runnableAgents.push({ id: "a-ledger", scope: "team", name: "Ledger Bot", model: null });
  vi.stubGlobal("fetch", fake.fetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function conversation(model = "glm"): string {
  const t = fake.addThread("Budget 2027");
  const q = fake.addEntry(t, null, { role: "user", content: "Sum the numbers" });
  fake.addEntry(t, q, {
    role: "assistant",
    content: [{ type: "text", text: "They add up to 42." }],
  });
  Object.assign(must(fake.threads.get(t)), {
    agent_id: "a-ledger",
    agent_name: "Ledger Bot",
    model,
  });
  fake.threadUsage.set(t, [
    {
      run_id: "r-1",
      user_entry_id: q,
      models: ["bifrost/glm-5.3"],
      calls: 3,
      input_tokens: 12_345,
      output_tokens: 678,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      cost_usd: 0.0421,
      unpriced_calls: 0,
      estimated_calls: 0,
    },
  ]);
  return t;
}

async function opened(t: string) {
  openApp(fake, t);
  await screen.findByText("They add up to 42.", {}, WAIT);
  await screen.findByRole("combobox", { name: "Model for this conversation" }, WAIT);
  return composer();
}

const menu = () => screen.findByRole("listbox", { name: /Actions|for \// }, WAIT);
const messagePosts = () => chatRequests(fake, "POST").filter((r) => r.path.endsWith("/messages"));

describe("/thinking (Pi's /thinking)", { timeout: 30_000 }, () => {
  it("lists the model's levels and saves the pick on the thread, like the picker", async () => {
    const t = conversation();
    const input = await opened(t);
    const user = userEvent.setup();
    await user.type(input, "/thinking ");
    const list = await menu();
    const names = within(list)
      .getAllByRole("option")
      .map((o) => o.textContent);
    // The model's default is the current choice (nothing picked yet).
    expect(names).toEqual([
      "Thinking low (default)current",
      "Thinking off",
      "Thinking low",
      "Thinking medium",
    ]);
    await user.type(input, "off");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(fake.threads.get(t)?.thinking_level).toBe("off"));
    expect(input).toHaveProperty("value", "");
    expect(messagePosts()).toEqual([]);
  });

  it("says why when the conversation's model has no levels to choose", async () => {
    const input = await opened(conversation("kimi"));
    const user = userEvent.setup();
    await user.type(input, "/thin");
    const option = within(await menu()).getByRole("option", { name: /^\/thinking/ });
    expect(option.getAttribute("aria-disabled")).toBe("true");
    expect(option.getAttribute("aria-label")).toMatch(/unavailable: .*no thinking levels/);
  });
});

describe("/session (Pi's /session)", { timeout: 30_000 }, () => {
  it("shows the conversation's details and usage", async () => {
    const input = await opened(conversation());
    const user = userEvent.setup();
    await user.type(input, "/session");
    await menu();
    await user.keyboard("{Enter}");
    const dialog = await screen.findByRole("dialog", { name: "This conversation" }, WAIT);
    const text = dialog.textContent ?? "";
    for (const part of [
      "Budget 2027",
      "Ledger Bot",
      "GLM 5.3",
      "Thinking low (default)",
      "12.3k",
      "678",
      "$0.04",
    ]) {
      expect(text).toContain(part);
    }
    expect(within(dialog).getByText("Runs").nextElementSibling?.textContent).toBe("1");
    expect(messagePosts()).toEqual([]);
  });
});

describe("/export (Pi's /export)", { timeout: 30_000 }, () => {
  function catchSaves(): string[] {
    const saved: string[] = [];
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:kobe/1");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      saved.push(`${this.getAttribute("href")} ${this.download}`);
    });
    return saved;
  }

  it("downloads this conversation as Markdown from the server, the team in the request", async () => {
    const t = conversation();
    const input = await opened(t);
    const saved = catchSaves();
    const user = userEvent.setup();
    await user.type(input, "/export");
    await menu();
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(saved).toEqual([`blob:kobe/1 2026-10-20-export-${t.slice(0, 8)}.md`]),
    );
    const req = fake.requests.find((r) => r.path.includes("/export"));
    expect(req).toMatchObject({
      path: `/v1/threads/${t}/export?team=${fake.teamId}`,
      team: fake.teamId,
    });
    expect(messagePosts()).toEqual([]);
  });

  it("a refused download shows the server's reason, and saves nothing (review LOW-4)", async () => {
    fake.exportRefusal = {
      status: 429,
      code: "export_in_progress",
      message: "An export is already running. Try again when it has finished.",
    };
    const input = await opened(conversation());
    const saved = catchSaves();
    const user = userEvent.setup();
    await user.type(input, "/export");
    await menu();
    await user.keyboard("{Enter}");
    expect(await screen.findByText(/An export is already running/, {}, WAIT)).toBeTruthy();
    expect(saved).toEqual([]);
  });
});

describe("Pi's words in the / menu", { timeout: 30_000 }, () => {
  it("/name offers Kobe's /rename", async () => {
    const input = await opened(conversation());
    const user = userEvent.setup();
    await user.type(input, "/name");
    const options = within(await menu()).getAllByRole("option");
    expect(options.map((o) => o.getAttribute("aria-label"))).toEqual(["/rename, Rename"]);
  });

  it("/login isn't offered: one disabled row with the reason; Enter sends nothing", async () => {
    const input = await opened(conversation());
    const user = userEvent.setup();
    await user.type(input, "/login");
    const [row] = within(await menu()).getAllByRole("option");
    expect(row?.getAttribute("aria-disabled")).toBe("true");
    expect(row?.textContent).toMatch(/^\/login isn't offered in Kobe: .*secrets out of it/);
    await user.keyboard("{Enter}");
    expect(input).toHaveProperty("value", "/login");
    expect(messagePosts()).toEqual([]);
  });

  it("after Escape, Enter still doesn't send /login; a leading space sends it as text (review LOW-5)", async () => {
    const input = await opened(conversation());
    const user = userEvent.setup();
    await user.type(input, "/login anthropic");
    await menu();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
    await user.keyboard("{Enter}");
    expect(input).toHaveProperty("value", "/login anthropic");
    expect(
      (await screen.findByText(/^\/login isn't offered in Kobe: .*Start with a space/)).closest(
        "[role=status]",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send" }).getAttribute("aria-disabled")).toBe("true");
    expect(messagePosts()).toEqual([]);

    await user.clear(input);
    await user.type(input, " /login anthropic");
    if (screen.queryByRole("listbox")) await user.keyboard("{Escape}");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(messagePosts()).toHaveLength(1));
  });
});
