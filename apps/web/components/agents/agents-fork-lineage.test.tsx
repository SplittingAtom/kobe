// @vitest-environment happy-dom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forbidNativeConfirm, renderTeam, stubApi, TEAM } from "../admin/testing";
import { entry, page, row } from "./roster-fixtures";
import {
  BUILDER,
  bodyOf,
  MEMBER,
  Page,
  ROSTER,
  rowAction,
  rowActions,
  rowOf,
} from "./roster-testing";

/**
 * The fork dialog with its binding notice, lineage and Compare with source, the declined marker and
 * the version link (KOBE-571, spec agents-roster AR8, §6.4, §6.6, §6.7, §7.5).
 */
beforeEach(() => {
  forbidNativeConfirm();
  localStorage.clear();
  window.history.replaceState(null, "", "/agents");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const LENT = row({
  agentId: "l-1",
  name: "Writer",
  slug: "writer",
  ownerUserId: "u-cy",
  ownerName: "Cy",
  entry: entry({ agentId: "l-1", assignedBy: "u-cy" }),
  forkBoundTeamId: TEAM.id,
  actions: { viewDefinition: true, fork: true },
});
const GALLERY = row({
  agentId: "g-1",
  kind: "gallery",
  name: "Kobe",
  slug: "kobe",
  ownerUserId: null,
  ownerName: null,
  forkBoundTeamId: null,
  actions: { viewDefinition: true, fork: true },
});

function navigateSpy() {
  const assign = vi.fn();
  vi.stubGlobal("location", { ...window.location, assign });
  return assign;
}

describe("Fork dialog (AR8, §6.7)", () => {
  it("forks team content into Personal, bound to the team, with the chosen name and slug", async () => {
    const assign = navigateSpy();
    const calls = stubApi({
      [ROSTER("team")]: [200, page("team", [LENT])],
      "POST /v1/agents/l-1/fork": [
        201,
        { agent: { id: "p-9", name: "My writer" }, boundTeamId: TEAM.id },
      ],
    });
    renderTeam(<Page search="tab=team" />, BUILDER);
    await rowAction("Writer", "Fork to Personal…");
    const dialog = await screen.findByRole("dialog", { name: "Fork Writer" });
    expect(within(dialog).getByText(/Your copy, in Personal/)).toBeTruthy();
    expect(within(dialog).getByRole("note").textContent).toBe(
      "Bound to Team Finance: usable only there.",
    );
    const name = within(dialog).getByLabelText("Name") as HTMLInputElement;
    const slug = within(dialog).getByLabelText(/^Slug/) as HTMLInputElement;
    expect([name.value, slug.value]).toEqual(["Writer", "writer"]);
    await userEvent.clear(name);
    await userEvent.type(name, "My writer");
    await userEvent.clear(slug);
    await userEvent.type(slug, "my-writer");
    await userEvent.click(within(dialog).getByRole("button", { name: "Fork and open" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/agents/p-9"));
    expect(bodyOf(calls, "POST", "/v1/agents/l-1/fork")).toEqual({
      name: "My writer",
      slug: "my-writer",
    });
  });

  it("forks a gallery agent unbound, and shows the server's refusal in the dialog", async () => {
    const assign = navigateSpy();
    stubApi({
      [ROSTER("site")]: [200, page("site", [GALLERY])],
      "POST /v1/agents/g-1/fork": [409, { code: "slug_taken", message: "That slug is taken." }],
    });
    renderTeam(<Page search="tab=site" />, MEMBER);
    await rowAction("Kobe", "Fork to Personal…");
    const dialog = await screen.findByRole("dialog", { name: "Fork Kobe" });
    expect(within(dialog).queryByRole("note")).toBeNull();
    expect(within(dialog).queryByText(/Bound to/)).toBeNull();
    await userEvent.click(within(dialog).getByRole("button", { name: "Fork and open" }));
    expect(await within(dialog).findByText("That slug is taken.")).toBeTruthy();
    expect(assign).not.toHaveBeenCalled();
  });
});

describe("Lineage on the Personal tab (§6.7, §7.5)", () => {
  const FORK = row({
    agentId: "p-1",
    name: "My writer",
    reach: [],
    forkedFrom: { agentId: "l-1", version: 2, name: "Writer", kind: "personal" },
    actions: { viewDefinition: true, edit: true, fork: true },
  });
  const HIDDEN = row({
    agentId: "p-2",
    name: "Old copy",
    reach: [],
    forkedFrom: { agentId: "x-1", version: 1, name: null, kind: null },
    actions: { viewDefinition: true, edit: true },
  });

  it("shows Forked from with a link where readable, anonymous otherwise", async () => {
    stubApi({ [ROSTER("personal")]: [200, page("personal", [FORK, HIDDEN])] });
    renderTeam(<Page />, MEMBER);
    const link = within(await rowOf("My writer")).getByRole("link", {
      name: "Forked from Writer v2",
    });
    expect(link.getAttribute("href")).toBe("/agents/l-1");
    const hidden = await rowOf("Old copy");
    expect(within(hidden).getByText("Forked from an agent you can't see v1")).toBeTruthy();
    expect(within(hidden).queryByRole("link", { name: /Forked from/ })).toBeNull();
    expect(await rowActions("Old copy")).not.toContain("Compare with source");
  });

  it("compares the copy's draft with the version it was forked from", async () => {
    stubApi({
      [ROSTER("personal")]: [200, page("personal", [FORK])],
      "GET /v1/agents/l-1/versions/2": [
        200,
        { version: { version: 2, prompt: "Write clearly.", frontmatter: { name: "Writer" } } },
      ],
      "GET /v1/agents/p-1": [200, { agent: { id: "p-1", prompt: "Write clearly and briefly." } }],
    });
    renderTeam(<Page />, MEMBER);
    await rowAction("My writer", "Compare with source");
    const dialog = await screen.findByRole("dialog", { name: "Compare My writer with its source" });
    expect(await within(dialog).findByText("Write clearly.")).toBeTruthy();
    expect(within(dialog).getByText("Write clearly and briefly.")).toBeTruthy();
    expect(within(dialog).getByText("Writer v2")).toBeTruthy();
  });
});

describe("Declined marker and version link (§6.4, §6.6)", () => {
  it("shows a decline without a note, and hides removals", async () => {
    stubApi({
      [ROSTER("personal")]: [
        200,
        page("personal", [
          row({
            agentId: "p-1",
            name: "Notes",
            reach: [
              {
                target: "team",
                teamId: TEAM.id,
                teamName: "Finance",
                state: "removed",
                note: null,
                declined: true,
              },
              {
                target: "site",
                teamId: null,
                teamName: null,
                state: "removed",
                note: "Not yet",
                declined: true,
              },
            ],
          }),
          row({
            agentId: "p-2",
            name: "Gone",
            reach: [
              {
                target: "team",
                teamId: TEAM.id,
                teamName: "Finance",
                state: "removed",
                note: null,
                declined: false,
              },
            ],
          }),
        ]),
      ],
    });
    renderTeam(<Page />, MEMBER);
    const notes = await rowOf("Notes");
    expect(within(notes).getByText("Declined for Team: Finance")).toBeTruthy();
    expect(within(notes).getByText("Declined for Site: Not yet")).toBeTruthy();
    expect(within(await rowOf("Gone")).getByText("Private")).toBeTruthy();
  });

  it("opens the version history from the version in effect: the View, or the owner's editor", async () => {
    stubApi({
      [ROSTER("team")]: [
        200,
        page("team", [
          LENT,
          row({ agentId: "p-1", name: "Mine", actions: { edit: true, viewDefinition: true } }),
          row({
            agentId: "p-3",
            name: "Hidden",
            ownerUserId: "u-x",
            entry: entry({ agentId: "p-3" }),
          }),
        ]),
      ],
    });
    renderTeam(<Page search="tab=team" />, BUILDER);
    const lent = within(await rowOf("Writer")).getByRole("link", { name: /^v2/ });
    expect(lent.getAttribute("href")).toBe("/agents/l-1#history-title");
    const mine = within(await rowOf("Mine")).getByRole("link", { name: /^v2/ });
    expect(mine.getAttribute("href")).toBe("/agents/p-1#history-title");
    expect(within(await rowOf("Hidden")).queryByRole("link", { name: /^v2/ })).toBeNull();
  });
});
