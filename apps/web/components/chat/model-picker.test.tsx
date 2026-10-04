// @vitest-environment happy-dom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { must } from "../../lib/testing/must";
import { chatRequests, composer, openApp, streaming } from "./testing";

/**
 * KOBE-44: the conversation's model picker in the composer (D30). Choices come from the team's
 * enabled models; the default is the team default; the choice is saved on the thread and a model
 * the team disabled since shows as unavailable.
 */
let fake: FakeKobe;

beforeEach(() => {
  sessionStorage.clear();
  fake = new FakeKobe();
  // The real test install: Ollama Cloud, kimi-k2.7-code the default, glm-5.3 enabled.
  fake.teamModels.push(
    { alias: "kimi", label: "Kimi K2.7 Code", enabled: true, is_default: true },
    { alias: "glm", label: "GLM 5.3", enabled: true, is_default: false },
    { alias: "gpt", label: null, enabled: false, is_default: false },
  );
  vi.stubGlobal("fetch", fake.fetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const picker = () =>
  screen.findByRole("combobox", {
    name: "Model for this conversation",
  }) as Promise<HTMLSelectElement>;

const optionNames = (select: HTMLSelectElement) =>
  within(select)
    .getAllByRole("option")
    .map((o) => o.textContent);

describe("model picker", () => {
  it("offers the team default and the enabled models only, on the team's header", async () => {
    openApp(fake);
    const select = await picker();
    expect(optionNames(select)).toEqual([
      "Team default (Kimi K2.7 Code)",
      "Kimi K2.7 Code",
      "GLM 5.3",
    ]);
    expect(select.value).toBe("");
    const read = fake.requests.find((r) => r.path === "/v1/team/models");
    expect(read?.team).toBe(fake.teamId);
  });

  it("a new conversation is created with the chosen model", async () => {
    openApp(fake);
    const user = userEvent.setup();
    await user.selectOptions(await picker(), "glm");
    await user.type(await composer(), "Summarise the report{Enter}");
    await waitFor(() => expect(fake.threads.size).toBe(1));
    expect(chatRequests(fake, "POST")[0]).toMatchObject({
      path: "/v1/threads",
      body: { title: "Summarise the report", model: "glm" },
    });
    const [thread] = [...fake.threads.values()];
    expect(thread?.model).toBe("glm");
    await waitFor(async () => expect((await picker()).value).toBe("glm"));
  });

  it("changes an open conversation's model on the thread, and back to the team default", async () => {
    const t = fake.addThread("Budget");
    openApp(fake, t);
    const user = userEvent.setup();
    await user.selectOptions(await picker(), "glm");
    await waitFor(() => expect(fake.threads.get(t)?.model).toBe("glm"));
    expect(chatRequests(fake, "PATCH").at(-1)).toMatchObject({
      path: `/v1/threads/${t}`,
      body: { model: "glm" },
      team: fake.teamId,
    });
    await user.selectOptions(await picker(), "");
    await waitFor(() => expect(fake.threads.get(t)?.model).toBeNull());
    expect(chatRequests(fake, "PATCH").at(-1)?.body).toEqual({ model: null });
  });

  it("shows a model the team disabled as unavailable, with the way out", async () => {
    const t = fake.addThread("Old choice");
    must(fake.threads.get(t)).model = "gpt";
    openApp(fake, t);
    const select = await picker();
    await waitFor(() => expect(select.value).toBe("gpt"));
    expect(optionNames(select)).toContain("gpt (unavailable)");
    expect(select.getAttribute("aria-invalid")).toBe("true");
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /gpt isn't enabled for your team any more.*Pick another model/,
    );
    await userEvent.setup().selectOptions(select, "kimi");
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(fake.threads.get(t)?.model).toBe("kimi");
  });

  it("re-reads the team's models when a run fails because its model was disabled", async () => {
    const t = fake.addThread("Chosen");
    must(fake.threads.get(t)).model = "glm";
    openApp(fake, t);
    const user = userEvent.setup();
    await waitFor(async () => expect((await picker()).value).toBe("glm"));
    // A team admin disables glm meanwhile; the next message fails with the server's error.
    must(fake.teamModels[1]).enabled = false;
    await user.type(await composer(), "hello{Enter}");
    const run = await waitFor(() => must(fake.activeRun(t)));
    await streaming(fake, run.run_id);
    fake.agent.fail(
      run.run_id,
      "agent_model_not_enabled",
      "The model chosen for this conversation (glm) isn't enabled for your team any more.",
    );
    expect(
      await screen.findByText(/isn't enabled for your team any more/, {
        selector: "p[role=alert]",
      }),
    ).toBeTruthy();
    expect(optionNames(await picker())).toContain("GLM 5.3 (unavailable)");
  });

  it("refuses a model the server says isn't enabled and keeps the thread's choice", async () => {
    const t = fake.addThread("Race");
    openApp(fake, t);
    const user = userEvent.setup();
    const select = await picker();
    must(fake.teamModels[1]).enabled = false; // disabled after the list was read
    await user.selectOptions(select, "glm");
    expect(await screen.findByText(/That model isn't enabled for your team/)).toBeTruthy();
    expect(fake.threads.get(t)?.model).toBeNull();
  });

  it("is locked to the agent's pinned model, which wins over the conversation's choice", async () => {
    const t = fake.addThread("Pinned");
    const thread = must(fake.threads.get(t));
    thread.model = "glm";
    thread.agent_model = "kimi";
    openApp(fake, t);
    const select = await picker();
    await waitFor(() => expect(select.value).toBe("kimi"));
    expect(select.disabled).toBe(true);
    expect(optionNames(select)).toEqual(["Kimi K2.7 Code"]);
    expect(screen.getByText("This agent always uses Kimi K2.7 Code.")).toBeTruthy();
    expect(chatRequests(fake, "PATCH")).toHaveLength(0);
  });

  it("stays out of the way when the team's models can't be read", async () => {
    fake.teamModels.length = 0; // the fake answers 404
    openApp(fake);
    await composer();
    expect(screen.queryByRole("combobox", { name: "Model for this conversation" })).toBeNull();
  });
});
