// @vitest-environment happy-dom
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderTeam, stubApi } from "../admin/testing";
import { CatalogDetailPage } from "./catalog-detail-page";
import { CatalogTab } from "./catalog-tab";

/** KOBE-336 (SK25, D28): the Catalog tab and a skill's detail. */
const MEMBER = { role: "member", permissions: ["team.read"] } as const;
const card = (name: string, over: Record<string, unknown> = {}) => ({
  id: `id-${name}`,
  name,
  summary: `${name} summary.`,
  publisher: "maintainer",
  status: "active",
  topics: ["finance"],
  latest: { version_id: "v", semver: "1.1.0", verdict: "pass", approved_at: null },
  score: { pass_rate: 0.9, lift: 0.3, cases: 5 },
  teams_installed: "few",
  state: { installed: null, added_by_me: false, blocked: false },
  ...over,
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Catalog tab", () => {
  it("shows cards with this team's state, and searches, filters and sorts", async () => {
    const page = (skills: unknown[]) => [200, { skills, tags: ["design", "finance"] }] as const;
    const calls = stubApi({
      "GET /v1/skills/catalog": page([
        card("sales-report", {
          state: {
            installed: { semver: "1.1.0", pin_mode: "pinned", access: "available" },
            added_by_me: false,
            blocked: false,
          },
        }),
        card("slide-maker", { state: { installed: null, added_by_me: true, blocked: true } }),
      ]),
      "GET /v1/skills/catalog?q=sales": page([card("sales-report")]),
      "GET /v1/skills/catalog?q=sales&tag=finance": page([card("sales-report")]),
      "GET /v1/skills/catalog?q=sales&tag=finance&sort=teams": page([card("sales-report")]),
    });
    renderTeam(<CatalogTab />, MEMBER);
    expect(await screen.findByRole("link", { name: "sales-report" })).toBeTruthy();
    expect(screen.getByText("Installed 1.1.0")).toBeTruthy();
    expect(screen.getByText("Added by me")).toBeTruthy();
    expect(screen.getByText("Blocked in this team")).toBeTruthy();
    expect(screen.getAllByText("passes 90% of its evals")).toHaveLength(2);
    await userEvent.type(screen.getByLabelText("Search"), "sales");
    await userEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(screen.queryByRole("link", { name: "slide-maker" })).toBeNull());
    await userEvent.selectOptions(await screen.findByLabelText("Topic"), "finance");
    await userEvent.selectOptions(await screen.findByLabelText("Sort by"), "teams");
    await waitFor(() =>
      expect(calls.map((c) => c.url)).toContain(
        "/v1/skills/catalog?q=sales&tag=finance&sort=teams",
      ),
    );
  });
});

describe("Catalog detail", () => {
  it("shows versions, changelogs, the authoritative card, and requests access to a host", async () => {
    const calls = stubApi({
      "GET /v1/skills/catalog/id-sales-report": [
        200,
        {
          ...card("sales-report"),
          skill_md: "# sales-report\n\nAdd a totals row.\n",
          files: [{ path: "SKILL.md", size: 30 }],
          versions: [
            {
              id: "v2",
              semver: "1.1.0",
              state: "approved",
              approved_at: null,
              changelog: "Faster.",
              verdict: "pass",
            },
            {
              id: "v1",
              semver: "1.0.0",
              state: "deprecated",
              approved_at: null,
              changelog: "First.",
              verdict: "pass",
            },
          ],
          authoritative_scorecard: { cases: 5, pass_rate_with: 0.9, lift: 0.3 },
          license: "Apache-2.0",
          egress: [
            { host: "pypi.org", enabled_here: true, in_ceiling: true },
            { host: "example.com", enabled_here: false, in_ceiling: true },
            { host: "evil.test", enabled_here: false, in_ceiling: false },
          ],
          packages: {},
          maintainers: ["Mia"],
          agents: [{ id: "a", name: "Reporter" }],
          can_request_egress: true,
        },
      ],
      "POST /v1/egress/requests": [201, { request: {} }],
    });
    renderTeam(<CatalogDetailPage skillId="id-sales-report" />, MEMBER);
    expect(await screen.findByRole("heading", { name: "sales-report", level: 1 })).toBeTruthy();
    expect(screen.getByText("Faster.")).toBeTruthy();
    expect(screen.getByText("First.")).toBeTruthy();
    expect(screen.getByText("90%")).toBeTruthy();
    expect(screen.getByText("enabled here")).toBeTruthy();
    expect(screen.getByText(/not allowed on this Site/)).toBeTruthy();
    expect(screen.getByText("Reporter")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Request access to example.com" }));
    expect(await screen.findByText("Asked your Team admins to enable example.com.")).toBeTruthy();
    const post = calls.find((c) => c.method === "POST");
    expect(JSON.parse(String(post?.body))).toEqual({ domain: "example.com" });
  });

  it("installs from the detail; a Builder isn't offered Required (KOBE-337)", async () => {
    const detail = {
      ...card("sales-report"),
      skill_md: null,
      files: [],
      versions: [
        {
          id: "v2",
          semver: "1.1.0",
          state: "approved",
          approved_at: null,
          changelog: null,
          verdict: "pass",
        },
        {
          id: "v1",
          semver: "1.0.0",
          state: "deprecated",
          approved_at: null,
          changelog: null,
          verdict: "pass",
        },
        {
          id: "v0",
          semver: "0.9.0",
          state: "revoked",
          approved_at: null,
          changelog: null,
          verdict: "pass",
        },
      ],
      authoritative_scorecard: null,
      license: null,
      egress: [],
      packages: {},
      maintainers: [],
      agents: [],
      can_request_egress: true,
    };
    const calls = stubApi({
      "GET /v1/skills/catalog/id-sales-report": [200, detail],
      "PUT /v1/team/skills/installs/id-sales-report": [
        200,
        { semver: "1.1.0", deprecated: false, required_count: 0 },
      ],
    });
    renderTeam(<CatalogDetailPage skillId="id-sales-report" />, {
      role: "builder",
      permissions: ["team.read", "team.skills.publish"],
    });
    const form = await screen.findByRole("form", { name: "Install in this team" });
    expect(Array.from(form.querySelectorAll("option")).map((o) => o.textContent)).not.toContain(
      "Required (always loaded)",
    );
    // Revoked versions are not offered.
    expect(Array.from(form.querySelectorAll("option")).map((o) => o.textContent)).not.toContain(
      "0.9.0",
    );
    await userEvent.selectOptions(screen.getByLabelText("Access"), "default_on");
    await userEvent.click(screen.getByRole("button", { name: "Install" }));
    expect(await screen.findByText("sales-report is set to 1.1.0.")).toBeTruthy();
    const put = calls.find((c) => c.method === "PUT");
    expect(JSON.parse(String(put?.body))).toEqual({
      version: "1.1.0",
      pinMode: "within_major",
      access: "default_on",
    });
  });
});
