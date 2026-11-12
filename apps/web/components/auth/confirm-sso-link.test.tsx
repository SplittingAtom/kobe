// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stubApi, summary } from "../admin/testing";
import { ConfirmSsoLink } from "./confirm-sso-link";

const PENDING = {
  pending: { provider_id: "p-1", provider_name: "Contoso", email: "ada@contoso.com" },
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ConfirmSsoLink (KOBE-630 review M1)", () => {
  it("names the provider and address and links only on Link", async () => {
    const calls = stubApi({
      "GET /v1/me/sso/pending-link": [200, PENDING],
      "POST /v1/me/sso/pending-link/confirm": [200, { linked: true }],
    });
    const onDone = vi.fn();
    render(<ConfirmSsoLink onDone={onDone} />);
    expect(await screen.findByText("ada@contoso.com")).toBeTruthy();
    expect(summary(calls)).toEqual(["GET /v1/me/sso/pending-link"]);
    await userEvent.click(screen.getByRole("button", { name: "Link Contoso" }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(summary(calls)).toContain("POST /v1/me/sso/pending-link/confirm");
  });

  it("drops the staged link on Don't link", async () => {
    const calls = stubApi({
      "GET /v1/me/sso/pending-link": [200, PENDING],
      "DELETE /v1/me/sso/pending-link": [200, { discarded: true }],
    });
    const onDone = vi.fn();
    render(<ConfirmSsoLink onDone={onDone} />);
    await userEvent.click(await screen.findByRole("button", { name: "Don't link" }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(summary(calls)).toEqual([
      "GET /v1/me/sso/pending-link",
      "DELETE /v1/me/sso/pending-link",
    ]);
  });

  it("shows the server's refusal", async () => {
    stubApi({
      "GET /v1/me/sso/pending-link": [200, PENDING],
      "POST /v1/me/sso/pending-link/confirm": [
        409,
        { code: "link_not_possible", message: "This sign-in can no longer be linked." },
      ],
    });
    render(<ConfirmSsoLink onDone={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: "Link Contoso" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/no longer be linked/);
  });

  it("says when nothing is waiting", async () => {
    stubApi({ "GET /v1/me/sso/pending-link": [200, { pending: null }] });
    render(<ConfirmSsoLink onDone={vi.fn()} />);
    expect(await screen.findByText("Nothing is waiting to be linked.")).toBeTruthy();
  });
});
