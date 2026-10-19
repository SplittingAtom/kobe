// @vitest-environment happy-dom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SkillTagsPage } from "./site/skill-tags-page";
import { renderSite, stubApi, summary } from "./testing";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const TAGS = [
  { id: "t-default", name: "default", kind: "system", status: "active" },
  { id: "t-fin", name: "finance", kind: "topic", status: "active" },
  { id: "t-old", name: "legacy", kind: "topic", status: "retired" },
];
const SKILL = {
  id: "s-1",
  name: "xlsx-pro",
  summary: "Spreadsheets.",
  publisher: "maintainer",
  status: "active",
  latest: "2.0.0",
  system: ["default"],
  topic: ["finance"],
  defaultMajor: 1,
  optOuts: "few",
};
const SYNC = {
  id: "j-1",
  skillId: "s-1",
  name: "xlsx-pro",
  kind: "add",
  major: 1,
  status: "running",
  createdAt: "2026-10-18T10:00:00.000Z",
  startedAt: "2026-10-18T10:00:01.000Z",
  finishedAt: null,
  teamsTotal: 3,
  teamsDone: 2,
  counts: null,
  attempts: 0,
  lastError: null,
  nextAttemptAt: null,
};
const FAILED = {
  ...SYNC,
  id: "j-0",
  status: "failed",
  finishedAt: "2026-10-18T09:00:00.000Z",
  attempts: 5,
  lastError: "no_version",
};

const routes = (extra: Record<string, unknown> = {}) => ({
  "GET /v1/site/skills/tags": [200, { tags: TAGS }],
  "GET /v1/site/skills/catalog": [200, { skills: [SKILL] }],
  "GET /v1/site/skills/default-syncs": [200, { syncs: [SYNC, FAILED] }],
  ...extra,
});

describe("Skill tags in the Site console (KOBE-314)", () => {
  it("lists topic tags, catalog skills with the Default badge, and sync progress", async () => {
    stubApi(routes() as never);
    renderSite(<SkillTagsPage />);
    const tags = await screen.findByRole("table", { name: "Topic tags" });
    expect(within(tags).getByText("finance")).toBeTruthy();
    expect(within(tags).getByText("Retired")).toBeTruthy();
    const skills = await screen.findByRole("table", { name: "Catalog skills" });
    const row = within(skills).getAllByRole("row")[1] as HTMLElement;
    expect(within(row).getByText("Site default")).toBeTruthy();
    expect(within(row).getByText(/major 1/)).toBeTruthy();
    expect(within(row).getByText(/Opted out: few/)).toBeTruthy();
    const syncs = await screen.findByRole("table", { name: "Default syncs" });
    expect(within(syncs).getAllByText("2 of 3 teams")).toHaveLength(2);
    // While a job runs no counts show (a step would name a team); below the minimum count the
    // breakdown is hidden, not partly shown.
    expect(within(syncs).getByText("Counts show when the sync ends")).toBeTruthy();
    expect(within(syncs).getAllByText(/Hidden: fewer than 3 teams/)).toHaveLength(1);
    expect(within(syncs).getByText("Failed after 5 attempts (no_version)")).toBeTruthy();
  });

  it("adds a topic tag", async () => {
    const calls = stubApi(
      routes({
        "POST /v1/site/skills/tags": [
          201,
          { tag: { id: "t-2", name: "documents", kind: "topic", status: "active" } },
        ],
      }) as never,
    );
    renderSite(<SkillTagsPage />);
    await screen.findByRole("table", { name: "Topic tags" });
    fireEvent.change(screen.getByLabelText("New topic tag"), { target: { value: "documents" } });
    fireEvent.click(screen.getByRole("button", { name: "Add tag" }));
    await waitFor(() => expect(summary(calls)).toContain("POST /v1/site/skills/tags"));
    const post = calls.find((c) => c.method === "POST");
    expect(JSON.parse(String(post?.body))).toEqual({ name: "documents" });
  });

  it("removes Default from a skill and moves Default installs to a new major", async () => {
    const calls = stubApi(
      routes({
        "PUT /v1/site/skills/catalog/s-1/tags": [
          200,
          { system: [], topic: ["finance"], syncId: "j-2" },
        ],
        "POST /v1/site/skills/catalog/s-1/default/move-major": [
          202,
          { syncId: "j-3", semver: "2.0.0" },
        ],
      }) as never,
    );
    renderSite(<SkillTagsPage />);
    const skills = await screen.findByRole("table", { name: "Catalog skills" });
    fireEvent.click(within(skills).getByRole("button", { name: "Edit tags of xlsx-pro" }));
    fireEvent.click(screen.getByLabelText(/Site default/));
    fireEvent.click(screen.getByRole("button", { name: "Save tags" }));
    await waitFor(() => expect(summary(calls)).toContain("PUT /v1/site/skills/catalog/s-1/tags"));
    // The catalog reloads after the change.
    const again = await screen.findByRole("button", { name: "Move Default to major 2" });
    fireEvent.click(again);
    await waitFor(() =>
      expect(summary(calls)).toContain("POST /v1/site/skills/catalog/s-1/default/move-major"),
    );
    const put = calls.find((c) => c.method === "PUT");
    expect(JSON.parse(String(put?.body))).toEqual({ system: [], topic: ["finance"] });
  });
});

describe("Catalog maintainers (KOBE-332)", () => {
  const user = (id: string, name: string) => ({
    id,
    name,
    email: `${id}@x.io`,
    siteRole: "user",
    deactivatedAt: null,
    createdAt: "2026-10-01T10:00:00Z",
  });
  const maintainer = (userId: string, name: string) => ({
    userId,
    name,
    email: `${userId}@x.io`,
    deactivated: false,
    addedAt: "2026-10-01T10:00:00Z",
  });

  it("marks an Unmaintained skill and lets a Site admin add and remove maintainers", async () => {
    const calls = stubApi(
      routes({
        "GET /v1/site/skills/catalog": [200, { skills: [{ ...SKILL, status: "unmaintained" }] }],
        "GET /v1/skills/catalog/s-1/maintainers": [
          [200, { maintainers: [maintainer("u-ann", "Ann")] }],
          [200, { maintainers: [maintainer("u-ann", "Ann"), maintainer("u-bob", "Bob")] }],
          [200, { maintainers: [maintainer("u-bob", "Bob")] }],
        ],
        "GET /v1/site/users": [200, { users: [user("u-ann", "Ann"), user("u-bob", "Bob")] }],
        "POST /v1/skills/catalog/s-1/maintainers": [200, { maintainers: [] }],
        "DELETE /v1/skills/catalog/s-1/maintainers/u-ann": [200, { maintainers: [] }],
      }),
    );
    renderSite(<SkillTagsPage />);
    expect(await screen.findByText("Unmaintained")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Maintainers of xlsx-pro" }));
    const group = await screen.findByRole("group", { name: "Maintainers of xlsx-pro" });
    await within(group).findByText("Ann (u-ann@x.io)");
    fireEvent.change(within(group).getByLabelText("Add maintainer"), {
      target: { value: "u-bob" },
    });
    fireEvent.click(within(group).getByRole("button", { name: "Add" }));
    await screen.findByText("Bob now maintains xlsx-pro.");
    fireEvent.click(await within(group).findByRole("button", { name: "Remove Ann" }));
    await screen.findByText("Ann no longer maintains xlsx-pro.");
    await waitFor(() =>
      expect(summary(calls)).toEqual(
        expect.arrayContaining([
          "POST /v1/skills/catalog/s-1/maintainers",
          "DELETE /v1/skills/catalog/s-1/maintainers/u-ann",
        ]),
      ),
    );
  });
});
