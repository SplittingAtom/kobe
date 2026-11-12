// @vitest-environment happy-dom
import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { answerConfirm, forbidNativeConfirm, renderTeam, stubApi, summary } from "../admin/testing";
import { MySignInMethodsPage } from "./my-sign-in-methods-page";

const MEMBER = { role: "member", permissions: ["team.chat"] } as const;
const LINK = {
  provider_id: "p-1",
  provider_name: "Contoso",
  linked_via: "admin_expected",
  email_at_link: "ada@contoso.com",
  linked_at: "2026-11-01T10:00:00.000Z",
  last_sign_in_at: null,
};

beforeEach(forbidNativeConfirm);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("My sign-in methods (KOBE-630)", () => {
  it("lists linked organization sign-ins and unlinks one after asking", async () => {
    const calls = stubApi({
      "GET /v1/me/sso/links": [
        [200, { links: [LINK] }],
        [200, { links: [] }],
      ],
      "DELETE /v1/me/sso/links/p-1": [200, { unlinked: true, sessions_ended: 0 }],
    });
    renderTeam(<MySignInMethodsPage />, MEMBER);
    expect(await screen.findByText("Linked by an admin")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Unlink Contoso" }));
    expect(await answerConfirm("Unlink Contoso?", "Unlink")).toMatch(/password and passkeys stay/);
    await screen.findByText("Contoso is unlinked.");
    expect(summary(calls)).toEqual([
      "GET /v1/me/sso/links",
      "DELETE /v1/me/sso/links/p-1",
      "GET /v1/me/sso/links",
    ]);
    expect(await screen.findByText(/No organization sign-in is linked/)).toBeTruthy();
  });

  it("shows the server's refusal for the only way to sign in", async () => {
    stubApi({
      "GET /v1/me/sso/links": [200, { links: [LINK] }],
      "DELETE /v1/me/sso/links/p-1": [
        409,
        { code: "last_sign_in_method", message: "This is your only way to sign in to Kobe." },
      ],
    });
    renderTeam(<MySignInMethodsPage />, MEMBER);
    await userEvent.click(await screen.findByRole("button", { name: "Unlink Contoso" }));
    await answerConfirm("Unlink Contoso?", "Unlink");
    expect(await screen.findByText(/only way to sign in/)).toBeTruthy();
  });

  it("says so when single sign-on is off (404)", async () => {
    stubApi({});
    renderTeam(<MySignInMethodsPage />, MEMBER);
    expect(await screen.findByText("Single sign-on is not set up on this site.")).toBeTruthy();
  });
});
