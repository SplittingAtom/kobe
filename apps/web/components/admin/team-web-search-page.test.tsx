// @vitest-environment happy-dom
import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { must } from "../../lib/testing/must";
import { TeamWebSearchPage } from "./team/web-search-page";
import { renderTeam, stubApi } from "./testing";

afterEach(cleanup);

describe("Team web search opt-in (KOBE-230)", () => {
  it("lets a team admin turn it on and explains where queries go", async () => {
    const calls = stubApi({
      "GET /v1/team/web-search": [
        [200, { available: true, enabled: false, provider: "brave" }],
        [200, { available: true, enabled: true, provider: "brave" }],
      ],
      "PUT /v1/team/web-search": [200, { available: true, enabled: true, provider: "brave" }],
    });
    renderTeam(<TeamWebSearchPage />);
    const toggle = await screen.findByRole("checkbox", { name: /Allow web search/ });
    expect((toggle as HTMLInputElement).checked).toBe(false);
    expect(screen.getByText(/queries is sent to Brave/)).toBeTruthy();
    await userEvent.click(toggle);
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText(/Web search is on for this team/);
    const put = must(calls.find((c) => c.method === "PUT"));
    expect(JSON.parse(String(put.body))).toEqual({ enabled: true });
  });

  it("turns it off again", async () => {
    const calls = stubApi({
      "GET /v1/team/web-search": [200, { available: true, enabled: true, provider: "exa" }],
      "PUT /v1/team/web-search": [200, { available: true, enabled: false, provider: "exa" }],
    });
    renderTeam(<TeamWebSearchPage />);
    const toggle = await screen.findByRole("checkbox", { name: /Allow web search/ });
    expect((toggle as HTMLInputElement).checked).toBe(true);
    await userEvent.click(toggle);
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText(/Web search is off for this team/);
    expect(JSON.parse(String(must(calls.find((c) => c.method === "PUT")).body))).toEqual({
      enabled: false,
    });
  });

  it("hides the toggle when the install has no provider configured", async () => {
    stubApi({
      "GET /v1/team/web-search": [200, { available: false, enabled: false, provider: null }],
    });
    renderTeam(<TeamWebSearchPage />);
    await screen.findByText(/has not set up a web search provider/);
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });
});
