// @vitest-environment happy-dom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { must } from "../../../lib/testing/must";
import { answerConfirm, forbidNativeConfirm, renderSite, stubApi } from "../testing";
import { GalleryAgentEditor } from "./gallery-agent-editor";

/**
 * Editing a gallery agent (KOBE-494): the two-tab creator at site scope, Save draft with If-Match,
 * Publish after asking, the Customized badge, the site's models and connectors, Dangerous mode
 * for site admins.
 */
const BASE = "/v1/site/gallery/agents";
const ATTACHED = {
  key: "kobe",
  generation: 2,
  customized: false,
  customized_at: null,
  customized_by: null,
  customized_from_generation: null,
  update_available: false,
};
const AGENT = {
  id: "a-1",
  scope: "gallery",
  slug: "kobe",
  name: "Kobe",
  status: "active",
  ownerUserId: null,
  currentVersion: 2,
  revision: 3,
  updatedAt: "2026-10-22T10:00:00Z",
  canEdit: true,
  canPublish: true,
  canExport: true,
  starters: [],
  frontmatter: { name: "Kobe" },
  prompt: "From the repository.",
  gallery: ATTACHED,
};
const CUSTOMIZED = {
  ...ATTACHED,
  customized: true,
  customized_at: "2026-10-23T09:00:00Z",
  customized_by: "u-me",
  customized_from_generation: 2,
};
const OPTIONS = {
  models: {
    models: [{ alias: "fast", label: "Fast", model: "m", enabled: true, is_default: false }],
    default: null,
  },
  connectors: [],
};
const VERSIONS = {
  currentVersion: 2,
  versions: [
    { version: 2, published_by: null, published_at: "2026-10-20T10:00:00Z" },
    { version: 1, published_by: null, published_at: "2026-10-01T10:00:00Z" },
  ],
  nextBefore: null,
};

beforeEach(() => forbidNativeConfirm());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const READ = {
  [`GET ${BASE}/a-1`]: [200, { agent: AGENT }],
  [`GET ${BASE}/builder-options`]: [200, OPTIONS],
  [`GET ${BASE}/a-1/versions`]: [200, VERSIONS],
} as const;

describe("gallery agent editor", () => {
  it("opens the two tabs with the site's models and the repository's versions", async () => {
    stubApi(READ);
    renderSite(<GalleryAgentEditor agentId="a-1" />);
    const identity = await screen.findByRole("tabpanel", { name: "Identity" });
    expect((within(identity).getByLabelText("System prompt") as HTMLTextAreaElement).value).toBe(
      "From the repository.",
    );
    expect(screen.queryByText("Customized")).toBeNull();
    expect(screen.getByText(/Saving a change marks it Customized/)).toBeTruthy();
    await userEvent.click(screen.getByRole("tab", { name: "Behaviour" }));
    const behaviour = screen.getByRole("tabpanel", { name: "Behaviour" });
    await within(behaviour).findByRole("option", { name: "Fast" });
    // Site admins may choose Dangerous mode (the server checks it again).
    expect(within(behaviour).getByRole("option", { name: /Dangerous/ })).toBeTruthy();
    expect(await screen.findByText("v2 (current)")).toBeTruthy();
    expect(screen.getAllByText("Repository")).toHaveLength(2);
  });

  it("saves the draft with If-Match and shows Customized", async () => {
    const saved = {
      agent: { ...AGENT, revision: 4, prompt: "Edited.", gallery: CUSTOMIZED },
    };
    const calls = stubApi({ ...READ, [`PUT ${BASE}/a-1`]: [200, saved] });
    renderSite(<GalleryAgentEditor agentId="a-1" />);
    const prompt = await screen.findByLabelText("System prompt");
    await userEvent.clear(prompt);
    await userEvent.type(prompt, "Edited.");
    expect(screen.getByRole("button", { name: "Publish…" }).hasAttribute("disabled")).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await screen.findByText("Draft saved.");
    const put = must(calls.find((c) => c.method === "PUT"));
    expect(put.url).toBe(`${BASE}/a-1`);
    expect(put.headers.get("if-match")).toBe('"3"');
    expect(JSON.parse(String(put.body))).toMatchObject({ prompt: "Edited." });
    expect(screen.getByText("Customized")).toBeTruthy();
    // Re-attaching is offered at any time from the editor.
    expect(screen.getByText(/Kobe is customized: releases no longer update it/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reset to repository (Kobe)" })).toBeTruthy();
  });

  it("resets a customized agent to the repository after asking", async () => {
    const customized = { ...AGENT, revision: 4, prompt: "Edited.", gallery: CUSTOMIZED };
    const reset = { ...AGENT, revision: 5, currentVersion: 4, gallery: ATTACHED };
    const calls = stubApi({
      ...READ,
      [`GET ${BASE}/a-1`]: [200, { agent: customized }],
      [`POST ${BASE}/a-1/reset`]: [200, { agent: reset }],
    });
    renderSite(<GalleryAgentEditor agentId="a-1" />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Reset to repository (Kobe)" }),
    );
    await answerConfirm("Reset Kobe to the repository definition?", "Reset to repository");
    await waitFor(() => expect(screen.queryByText("Customized")).toBeNull());
    expect((screen.getByLabelText("System prompt") as HTMLTextAreaElement).value).toBe(
      "From the repository.",
    );
    expect(calls.filter((c) => c.method === "POST").map((c) => c.url)).toEqual([
      `${BASE}/a-1/reset`,
    ]);
  });

  it("publishes after asking and reloads the agent and its history", async () => {
    const published = { ...AGENT, currentVersion: 3, gallery: CUSTOMIZED };
    const calls = stubApi({
      ...READ,
      [`GET ${BASE}/a-1`]: [
        [200, { agent: AGENT }],
        [200, { agent: published }],
      ],
      [`POST ${BASE}/a-1/publish`]: [
        201,
        {
          agent: published,
          version: { version: 3, published_by: "u-me", published_at: "2026-10-23T10:00:00Z" },
        },
      ],
    });
    renderSite(<GalleryAgentEditor agentId="a-1" />);
    await userEvent.click(await screen.findByRole("button", { name: "Publish…" }));
    await answerConfirm("Publish Kobe to every team?", "Cancel");
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "Publish…" }));
    await answerConfirm("Publish Kobe to every team?", "Publish");
    await screen.findByText("Published v3.");
    const post = must(calls.find((c) => c.method === "POST"));
    expect(post.headers.get("if-match")).toBe('"3"');
    await waitFor(() => expect(screen.getByText("Customized")).toBeTruthy());
    expect(screen.getByText("Current version: v3.")).toBeTruthy();
  });

  it("keeps an archived agent read-only", async () => {
    stubApi({
      ...READ,
      [`GET ${BASE}/a-1`]: [200, { agent: { ...AGENT, archivedAt: "2026-10-02T10:00:00Z" } }],
    });
    renderSite(<GalleryAgentEditor agentId="a-1" />);
    await screen.findByText(/archived, so it can't be changed/);
    expect(screen.queryByRole("button", { name: "Save draft" })).toBeNull();
  });
});
