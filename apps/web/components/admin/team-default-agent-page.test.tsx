// @vitest-environment happy-dom
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { must } from "../../lib/testing/must";
import { TeamDefaultAgentPage } from "./team/default-agent-page";
import { forbidNativeConfirm, renderTeam, stubApi } from "./testing";

beforeEach(forbidNativeConfirm);
afterEach(cleanup);

const OPTIONS = [
  { agentId: "t-1", name: "Triage", slug: "triage", group: "team", versionInEffect: 3 },
  { agentId: "l-1", name: "Writer", slug: "writer", group: "team", versionInEffect: 2 },
  { agentId: "g-1", name: "Kobe", slug: "kobe", group: "site", versionInEffect: 1 },
];

describe("Team default agent (KOBE-571, agents-roster §7.7)", () => {
  it("starts on the site default and a team admin picks an agent from the roster", async () => {
    const calls = stubApi({
      "GET /v1/team/default-agent": [
        [200, { agentId: null, unavailable: false, options: OPTIONS }],
        [200, { agentId: "l-1", unavailable: false, options: OPTIONS }],
      ],
      "PUT /v1/team/default-agent": [200, { agentId: "l-1", unavailable: false, options: OPTIONS }],
    });
    renderTeam(<TeamDefaultAgentPage />);
    const select = (await screen.findByRole("combobox", {
      name: /New conversations start with/,
    })) as HTMLSelectElement;
    expect(select.value).toBe("");
    const groups = [...select.querySelectorAll("optgroup")].map((g) => [
      g.label,
      [...g.querySelectorAll("option")].map((o) => o.textContent),
    ]);
    expect(groups).toEqual([
      ["Team roster", ["Triage (v3)", "Writer (v2)"]],
      ["Site roster", ["Kobe (v1)"]],
    ]);
    const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    await userEvent.selectOptions(select, "l-1");
    await userEvent.click(save);
    await screen.findByText("New conversations in this team start with Writer.");
    expect(JSON.parse(String(must(calls.find((c) => c.method === "PUT")).body))).toEqual({
      agentId: "l-1",
    });
  });

  it("says when the chosen agent is unavailable and goes back to the site default", async () => {
    const calls = stubApi({
      "GET /v1/team/default-agent": [200, { agentId: "x-1", unavailable: true, options: OPTIONS }],
      "PUT /v1/team/default-agent": [200, { agentId: null, unavailable: false, options: OPTIONS }],
    });
    renderTeam(<TeamDefaultAgentPage />);
    const form = await screen.findByRole("form", { name: "Default agent" });
    expect(within(form).getByText(/no longer on the team's roster/)).toBeTruthy();
    await userEvent.click(within(form).getByRole("button", { name: "Save" }));
    await screen.findByText("New conversations start with the site default.");
    expect(JSON.parse(String(must(calls.find((c) => c.method === "PUT")).body))).toEqual({
      agentId: null,
    });
  });

  it("shows the server's refusal", async () => {
    stubApi({
      "GET /v1/team/default-agent": [200, { agentId: null, unavailable: false, options: OPTIONS }],
      "PUT /v1/team/default-agent": [
        422,
        { code: "agent_not_eligible", message: "Choose an agent on the team's roster." },
      ],
    });
    renderTeam(<TeamDefaultAgentPage />);
    const select = await screen.findByRole("combobox", { name: /New conversations start with/ });
    await userEvent.selectOptions(select, "t-1");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Choose an agent on the team's roster.")).toBeTruthy();
  });
});
