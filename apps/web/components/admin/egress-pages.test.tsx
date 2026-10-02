// @vitest-environment happy-dom
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { must } from "../../lib/testing/must";
import { EgressCeilingPage } from "./install/egress-ceiling-page";
import { TeamEgressPage } from "./team/egress-page";
import { TEAM, renderInstall, renderTeam, stubApi, summary } from "./testing";

const entry = (domain: string, preset: string | null, in_ceiling: boolean) => ({
  domain,
  preset,
  in_ceiling,
  note: null,
  created_by: null,
  created_at: "2026-10-01T10:00:00Z",
  updated_at: "2026-10-01T10:00:00Z",
});

const CEILING = {
  domains: [
    entry("pypi.org", "package_registries", true),
    entry("github.com", "git_hosts", false),
    entry("*.example.com", null, true),
  ],
  presets: ["package_registries", "git_hosts", "web_search"],
};

beforeEach(() =>
  vi.stubGlobal(
    "confirm",
    vi.fn(() => true),
  ),
);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Install egress ceiling", () => {
  it("lists domains by preset and offers delete for custom domains only", async () => {
    stubApi({ "GET /v1/install/egress-ceiling": [200, CEILING] });
    renderInstall(<EgressCeilingPage />);
    const registries = await screen.findByRole("table", { name: "Package registries" });
    expect(registries.textContent).toContain("pypi.org");
    expect(within(registries).queryByRole("button", { name: /Delete/ })).toBeNull();
    expect(screen.getByRole("table", { name: "Git hosts" }).textContent).toContain("github.com");
    expect(
      within(screen.getByRole("table", { name: "Custom domains" })).getByRole("button", {
        name: "Delete *.example.com",
      }),
    ).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "pypi.org in the ceiling" })).toHaveProperty(
      "checked",
      true,
    );
  });

  it("toggles a domain and a whole preset, and deletes a custom domain", async () => {
    const calls = stubApi({
      "GET /v1/install/egress-ceiling": [200, CEILING],
      "PUT /v1/install/egress-ceiling/github.com": [
        200,
        { domain: entry("github.com", "git_hosts", true) },
      ],
      "PUT /v1/install/egress-ceiling/presets/package_registries": [200, CEILING],
      "DELETE /v1/install/egress-ceiling/*.example.com": [204],
    });
    renderInstall(<EgressCeilingPage />);
    await userEvent.click(
      await screen.findByRole("checkbox", { name: "github.com in the ceiling" }),
    );
    await screen.findByText(/github.com is in the ceiling/);
    const put = must(calls.find((c) => c.url === "/v1/install/egress-ceiling/github.com"));
    expect(JSON.parse(String(put.body))).toEqual({ in_ceiling: true });
    await userEvent.click(screen.getByRole("button", { name: "Remove all package registries" }));
    await screen.findByText(/all out of the ceiling/);
    await userEvent.click(screen.getByRole("button", { name: "Delete *.example.com" }));
    await screen.findByText("Deleted *.example.com.");
    expect(summary(calls)).toContain("DELETE /v1/install/egress-ceiling/*.example.com");
  });

  it("adds a domain and shows the server's validation errors", async () => {
    const calls = stubApi({
      "GET /v1/install/egress-ceiling": [200, CEILING],
      "POST /v1/install/egress-ceiling": [
        [201, { domain: entry("api.vendor.io", null, true) }],
        [
          400,
          {
            code: "invalid_request",
            message:
              "Check the request: domain must be a host name such as pypi.org (no IP addresses).",
          },
        ],
      ],
    });
    renderInstall(<EgressCeilingPage />);
    const form = await screen.findByRole("form", { name: "Add a domain" });
    await userEvent.type(within(form).getByLabelText("Domain"), "api.vendor.io");
    await userEvent.type(within(form).getByLabelText("Note (optional)"), "Vendor");
    await userEvent.click(within(form).getByRole("button", { name: "Add domain" }));
    await screen.findByText("Added api.vendor.io to the ceiling.");
    const post = must(calls.find((c) => c.method === "POST"));
    expect(JSON.parse(String(post.body))).toEqual({ domain: "api.vendor.io", note: "Vendor" });
    await userEvent.type(within(form).getByLabelText("Domain"), "10.0.0.1");
    await userEvent.click(within(form).getByRole("button", { name: "Add domain" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/no IP addresses/);
  });
});

describe("Team egress", () => {
  const team = (domain: string, in_ceiling: boolean, enabled: boolean) => ({
    domain,
    preset: null,
    in_ceiling,
    enabled,
    enabled_by: enabled ? "u" : null,
    enabled_at: enabled ? "2026-10-01T10:00:00Z" : null,
  });

  it("enables a ceiling domain with the team header, and shows suspended entries", async () => {
    const calls = stubApi({
      "GET /v1/team/egress": [
        200,
        {
          domains: [team("pypi.org", true, false), team("old.example.com", false, true)],
        },
      ],
      "PUT /v1/team/egress/domains/pypi.org": [201, { domain: "pypi.org", enabled: true }],
      "DELETE /v1/team/egress/domains/old.example.com": [204],
    });
    renderTeam(<TeamEgressPage />);
    const table = await screen.findByRole("table", { name: /Domains/ });
    expect(table.textContent).toMatch(/old.example.com.*Suspended \(not in the install ceiling\)/);
    await userEvent.click(screen.getByRole("checkbox", { name: "pypi.org enabled" }));
    await screen.findByText("Enabled pypi.org for the team's sandboxes.");
    await userEvent.click(screen.getByRole("button", { name: "Disable old.example.com" }));
    await screen.findByText(/Disabled old.example.com/);
    expect(summary(calls)).toEqual(
      expect.arrayContaining([
        "PUT /v1/team/egress/domains/pypi.org",
        "DELETE /v1/team/egress/domains/old.example.com",
      ]),
    );
    expect(calls.every((c) => c.headers.get("x-kobe-team") === TEAM.id)).toBe(true);
  });

  it("shows the server's refusal", async () => {
    stubApi({
      "GET /v1/team/egress": [200, { domains: [team("pypi.org", true, false)] }],
      "PUT /v1/team/egress/domains/pypi.org": [
        409,
        { code: "not_in_ceiling", message: "That domain is not in the install's egress ceiling." },
      ],
    });
    renderTeam(<TeamEgressPage />);
    await userEvent.click(await screen.findByRole("checkbox", { name: "pypi.org enabled" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/not in the install/);
  });
});
