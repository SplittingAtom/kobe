// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  requestReload,
  resetReloadRequest,
  stashDraftForReload,
  takeReloadDraft,
} from "../../lib/build/reload-draft";
import { IconActionProvider } from "./icon-action";
import { ProfileMenu } from "./profile-menu";

const signOut = vi.fn(async () => ({ data: {}, error: null }));
vi.mock("../../lib/auth-client", () => ({ authClient: { signOut: () => signOut() } }));

afterEach(() => {
  cleanup();
  resetReloadRequest();
  sessionStorage.clear();
  vi.restoreAllMocks();
});

/** KOBE-487: sign-out drops a composer draft kept for the new-build Reload. */
describe("ProfileMenu sign-out", () => {
  it("forgets the drafts kept for a reload", async () => {
    const assign = vi.spyOn(window.location, "assign").mockImplementation(() => {});
    requestReload();
    stashDraftForReload("t1", "private draft");
    render(
      <IconActionProvider>
        <ProfileMenu />
      </IconActionProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/sign-in"));
    expect(takeReloadDraft("t1")).toBeUndefined();
  });
});
