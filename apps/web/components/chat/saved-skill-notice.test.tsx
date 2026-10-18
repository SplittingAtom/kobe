// @vitest-environment happy-dom
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { clearSavedSkill, showSavedSkill } from "../../lib/skills/saved-notice";
import { IconActionProvider } from "../shell/icon-action";
import { SavedSkillNotice } from "./saved-skill-notice";

const view = () =>
  render(
    <IconActionProvider>
      <SavedSkillNotice />
    </IconActionProvider>,
  );

/** Save skill to Workbench keeps the chat open and links the draft (KOBE-322, coordinator). */
afterEach(() => {
  cleanup();
  clearSavedSkill();
});

describe("SavedSkillNotice", () => {
  it("shows nothing until a skill is saved, then a link to its draft", () => {
    view();
    expect(screen.queryByRole("status")).toBeNull();
    act(() => showSavedSkill({ draftId: "d-1", name: "close-helper", updated: false }));
    expect(screen.getByRole("status").textContent).toContain("Saved close-helper");
    expect(screen.getByRole("link", { name: "Open the draft" }).getAttribute("href")).toBe(
      "/me/skills/drafts/d-1",
    );
  });

  it("says Updated for a re-save, and closes", async () => {
    view();
    act(() => showSavedSkill({ draftId: "d-2", name: "close-helper", updated: true }));
    expect(screen.getByRole("status").textContent).toContain("Updated close-helper");
    await userEvent.setup().click(screen.getByRole("button", { name: /Dismiss saved skill/ }));
    expect(screen.queryByRole("status")).toBeNull();
  });
});
