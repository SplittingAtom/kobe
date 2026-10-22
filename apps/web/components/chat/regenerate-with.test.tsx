// @vitest-environment happy-dom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { must } from "../../lib/testing/must";
import { chatRequests, openApp, streaming } from "./testing";

/**
 * KOBE-217 (CE17): Regenerate is a split button. Regenerate keeps the model; "Regenerate with…"
 * lists the team's enabled models. Choosing one switches the thread's model (like the picker),
 * then regenerates as a sibling; Pi records the switch as a `model_change` entry before the new
 * prompt, so its marker shows above the new version.
 */
let fake: FakeKobe;

beforeEach(() => {
  sessionStorage.clear();
  fake = new FakeKobe();
  fake.teamModels.push(
    {
      alias: "kimi",
      label: "Kimi K2.7 Code",
      enabled: true,
      is_default: true,
      context_window: 200_000,
    },
    { alias: "glm", label: "GLM 5.3", enabled: true, is_default: false, context_window: 1_000_000 },
    { alias: "gpt", label: "GPT", enabled: false, is_default: false },
  );
  vi.stubGlobal("fetch", fake.fetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const ask = (content: string) => ({ role: "user", content });
const say = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });

/** Like Pi 1.0: the session's first model and a settings entry at the root, then one turn. */
function oneTurn() {
  const t = fake.addThread("Report");
  const first = fake.addSystemEntry(t, null, "model_change", { provider: "kobe", modelId: "kimi" });
  const root = fake.addSystemEntry(t, first, "thinking_level_change", { thinkingLevel: "off" });
  const u1 = fake.addEntry(t, root, ask("summarise it"));
  fake.addEntry(t, u1, say("kimi answer"));
  return { t, root };
}

const trigger = () => screen.findByRole("button", { name: "Regenerate with…" });
const picker = () =>
  screen.findByRole("combobox", {
    name: "Model for this conversation",
  }) as Promise<HTMLSelectElement>;
const messagePosts = () => chatRequests(fake, "POST").filter((r) => r.path.endsWith("/messages"));
const version = () => screen.getAllByText(/^Version/)[0]?.textContent;

async function chooseModel(name: string) {
  const user = userEvent.setup();
  await user.click(await trigger());
  const menu = await screen.findByRole("menu", { name: "Regenerate with…" });
  await user.click(within(menu).getByRole("menuitem", { name }));
}

/** The sandbox agent's run: branch marker, Pi's model switch, the prompt and the answer. */
async function answer(t: string, modelId: string, text: string) {
  const run = await waitFor(() => must(fake.activeRun(t)));
  await streaming(fake, run.run_id);
  fake.agent.branchMarker(run.run_id);
  fake.agent.modelChange(run.run_id, modelId);
  fake.agent.commitPrompt(run.run_id);
  fake.agent.commit(run.run_id, say(text));
  fake.agent.complete(run.run_id);
  expect(await screen.findByText(text)).toBeTruthy();
  return run;
}

/** The model markers shown, by their text. */
const modelMarkers = () =>
  [...document.querySelectorAll('[data-kobe-marker="model"]')].map((m) =>
    (m.textContent ?? "").replace(/\s+/g, " ").trim(),
  );

/** The model marker shown on the version on screen, and whether it sits above the prompt. */
function markerAbovePrompt(model: string): boolean {
  const marker = must(
    [...document.querySelectorAll('[data-kobe-marker="model"]')].find((m) =>
      m.textContent?.includes(model),
    ),
  );
  const prompt = screen.getByText("summarise it");
  return (marker.compareDocumentPosition(prompt) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

describe("Regenerate with another model (KOBE-217)", () => {
  it("offers the team default and the enabled models only, the thread's current choice marked", async () => {
    const { t } = oneTurn();
    openApp(fake, t);
    await screen.findByText("kimi answer");
    const user = userEvent.setup();
    await user.click(await trigger());
    const menu = await screen.findByRole("menu", { name: "Regenerate with…" });
    // Portalled into the chat root, where the theme tokens and the preflight slice apply (KOBE-282).
    expect(menu.closest("[data-kobe-chat]")).not.toBeNull();
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((i) => i.textContent),
    ).toEqual(["Team default (Kimi K2.7 Code) (current)", "Kimi K2.7 Code", "GLM 5.3"]);
  });

  it("switches the thread's model, then regenerates as a sibling with a model marker above it (ac-1)", async () => {
    const { t, root } = oneTurn();
    openApp(fake, t);
    await screen.findByText("kimi answer");
    await chooseModel("GLM 5.3");

    await waitFor(() => expect(messagePosts()).toHaveLength(1));
    // The model is saved on the thread first, so the run (and the next turns) use it.
    const requests = chatRequests(fake);
    const patch = requests.findIndex((r) => r.method === "PATCH" && r.path === `/v1/threads/${t}`);
    const post = requests.findIndex((r) => r.method === "POST" && r.path.endsWith("/messages"));
    expect(requests[patch]?.body).toEqual({ model: "glm" });
    expect(patch).toBeLessThan(post);
    expect(messagePosts()[0]?.body).toEqual({
      content: "summarise it",
      parent_entry_id: root,
      viewing_from_entry: expect.any(String),
    });

    const run = await answer(t, "glm", "glm answer");
    expect(fake.run(run.run_id).model).toBe("glm");
    expect(screen.queryByText("kimi answer")).toBeNull();
    await waitFor(() => expect(version()).toBe("Version 2 of 2"));
    expect(markerAbovePrompt("glm")).toBe(true);
    // The session's first model reads as the thread's, not as a change (KOBE-280).
    expect(modelMarkers()).toEqual(["Model: kimi", "Model changed to glm"]);
    await waitFor(async () => expect((await picker()).value).toBe("glm"));

    // The first version had no switch: its change marker stays with the new branch.
    await userEvent
      .setup()
      .click(must(screen.getAllByRole("button", { name: "Previous version" })[0]));
    expect(await screen.findByText("kimi answer")).toBeTruthy();
    expect(modelMarkers()).toEqual(["Model: kimi"]);
  });

  it("switching back to the thread's first model shows it as the thread's model (ac-3)", async () => {
    const { t } = oneTurn();
    openApp(fake, t);
    await screen.findByText("kimi answer");
    await chooseModel("GLM 5.3");
    await answer(t, "glm", "glm answer");
    await waitFor(async () => expect((await picker()).value).toBe("glm"));

    await chooseModel("Kimi K2.7 Code");
    await waitFor(() => expect(fake.threads.get(t)?.model).toBe("kimi"));
    await answer(t, "kimi", "kimi again");
    await waitFor(() => expect(version()).toBe("Version 3 of 3"));
    expect(markerAbovePrompt("kimi")).toBe(true);
    // Version 3 branches below version 2's switch (like real Pi); the chain kimi → glm → kimi has
    // no message between, so it nets out to the thread's first model: no change shows (KOBE-280).
    expect(modelMarkers()).toEqual(["Model: kimi"]);
    await waitFor(async () => expect((await picker()).value).toBe("kimi"));
  });

  it("the thread's current choice regenerates without a model change", async () => {
    const { t } = oneTurn();
    openApp(fake, t);
    await screen.findByText("kimi answer");
    await chooseModel("Team default (Kimi K2.7 Code) (current)");
    await waitFor(() => expect(messagePosts()).toHaveLength(1));
    expect(chatRequests(fake, "PATCH")).toHaveLength(0);
    expect(fake.threads.get(t)?.model).toBeNull();
  });

  it("the team default entry makes the thread follow the default again, not pin its alias", async () => {
    const { t } = oneTurn();
    must(fake.threads.get(t)).model = "glm";
    openApp(fake, t);
    await screen.findByText("kimi answer");
    await chooseModel("Team default (Kimi K2.7 Code)");
    await waitFor(() => expect(messagePosts()).toHaveLength(1));
    expect(chatRequests(fake, "PATCH").map((r) => r.body)).toEqual([{ model: null }]);
    await waitFor(async () => expect((await picker()).value).toBe(""));
  });

  it("a regenerate that can't be sent puts the model back and shows why", async () => {
    const { t } = oneTurn();
    fake.failNext.set(
      `POST /v1/threads/${t}/messages`,
      new Response(
        JSON.stringify({ code: "thread_busy", message: "The server could not take it." }),
        { status: 409, headers: { "content-type": "application/json" } },
      ),
    );
    openApp(fake, t);
    await screen.findByText("kimi answer");
    await chooseModel("GLM 5.3");
    expect(await screen.findByText(/The server could not take it/)).toBeTruthy();
    await waitFor(() =>
      expect(chatRequests(fake, "PATCH").map((r) => r.body)).toEqual([
        { model: "glm" },
        { model: null },
      ]),
    );
    expect(fake.threads.get(t)?.model).toBeNull();
    await waitFor(async () => expect((await picker()).value).toBe(""));
  });

  it("is disabled like Regenerate for a thread in Trash, and changes nothing", async () => {
    const { t } = oneTurn();
    must(fake.threads.get(t)).deleted_at = "2026-10-14T10:00:00.000Z";
    openApp(fake, t);
    await screen.findByText("kimi answer");
    const button = await trigger();
    expect(button.getAttribute("aria-disabled")).toBe("true");
    await userEvent.setup().click(button);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(chatRequests(fake, "PATCH")).toHaveLength(0);
  });

  it("a model disabled since the list was read fails with the server's error and nothing runs", async () => {
    const { t } = oneTurn();
    openApp(fake, t);
    await screen.findByText("kimi answer");
    must(fake.teamModels[1]).enabled = false; // a team admin disables GLM meanwhile
    await chooseModel("GLM 5.3");
    expect(await screen.findByText(/That model isn't enabled for your team/)).toBeTruthy();
    expect(messagePosts()).toHaveLength(0);
    expect(fake.threads.get(t)?.model).toBeNull();
  });

  it("is hidden for a pinned agent's thread; Regenerate stays (ac-2)", async () => {
    const { t } = oneTurn();
    must(fake.threads.get(t)).agent_model = "kimi";
    openApp(fake, t);
    await screen.findByText("kimi answer");
    expect(await screen.findByRole("button", { name: "Regenerate" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Regenerate with…" })).toBeNull();
  });

  it("is hidden on a thread shared read-only", async () => {
    const { t } = oneTurn();
    must(fake.threads.get(t)).read_only = true;
    openApp(fake, t);
    await screen.findByText("kimi answer");
    expect(screen.queryByRole("button", { name: "Regenerate" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Regenerate with…" })).toBeNull();
  });

  it("the gauge re-scales to the new model and then reads the new version's call", async () => {
    const { t } = oneTurn();
    fake.threadLatestCall.set(t, {
      run_id: "00000000-0000-4000-8000-0000000000aa",
      at: "2026-10-14T10:00:00.000Z",
      model: "ollama/kimi",
      input_tokens: 150_000,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
    });
    openApp(fake, t);
    const gauge = await screen.findByRole("meter", { name: "Context used" });
    await waitFor(() => expect(gauge.getAttribute("aria-valuemax")).toBe("200000"));
    await chooseModel("GLM 5.3");
    await waitFor(() => expect(gauge.getAttribute("aria-valuemax")).toBe("1000000"));

    const run = await waitFor(() => must(fake.activeRun(t)));
    fake.threadLatestCall.set(t, {
      run_id: run.run_id,
      at: "2026-10-14T10:05:00.000Z",
      model: "ollama/glm",
      input_tokens: 40_000,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
    });
    await answer(t, "glm", "glm answer");
    // run_usage is read a moment after the run ends (the gateway's flush): the new version's call.
    await waitFor(
      () =>
        expect(
          screen.getByRole("meter", { name: "Context used" }).getAttribute("aria-valuetext"),
        ).toBe("40k of 1M tokens (4%) · GLM 5.3"),
      { timeout: 5_000 },
    );
  });
});
