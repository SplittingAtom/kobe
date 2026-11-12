// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ssoErrorMessage } from "../../lib/sso-errors";
import { SsoSignIn, ssoStartHref } from "./sso-sign-in";

/** KOBE-628 (spec sso-oidc-scim §5): sign-in buttons and the sso_error messages. */
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function stubProviders(status: number, body: unknown) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("SsoSignIn", () => {
  it("shows one button per enabled provider, linking to its start route", async () => {
    const fetchMock = stubProviders(200, {
      providers: [
        { slug: "corp", displayName: "Contoso" },
        { slug: "kc", displayName: "Keycloak" },
      ],
    });
    render(<SsoSignIn />);
    const corp = await screen.findByRole("link", { name: "Sign in with Contoso" });
    expect(corp.getAttribute("href")).toBe("/api/auth/sso/start/corp?returnTo=%2F");
    expect(screen.getByRole("link", { name: "Sign in with Keycloak" })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/sso/providers", expect.anything());
  });

  it("shows nothing when single sign-on is off (404)", async () => {
    const fetchMock = stubProviders(404, { message: "Not found" });
    render(<SsoSignIn />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("ignores malformed provider entries", async () => {
    stubProviders(200, { providers: [{ slug: 1 }, null, { slug: "ok", displayName: "OK" }] });
    render(<SsoSignIn />);
    await screen.findByRole("link", { name: "Sign in with OK" });
    expect(screen.getAllByRole("link")).toHaveLength(1);
  });

  it("encodes the slug and returnTo", () => {
    expect(ssoStartHref("corp", "/chat?x=1")).toBe(
      "/api/auth/sso/start/corp?returnTo=%2Fchat%3Fx%3D1",
    );
  });
});

describe("ssoErrorMessage", () => {
  it.each([
    "no_access",
    "link_required",
    "deactivated",
    "mfa_missing",
    "groups_overage",
    "tenant_mismatch",
    "state_invalid",
    "token_invalid",
    "idp_unreachable",
  ])("has a plain message for %s", (code) => {
    const message = ssoErrorMessage(code);
    expect(message).toBeTruthy();
    expect(message).not.toMatch(/Single sign-on did not work/);
  });

  it("falls back for unknown codes and is null without one", () => {
    expect(ssoErrorMessage("<script>")).toMatch(/Single sign-on did not work/);
    expect(ssoErrorMessage(null)).toBeNull();
    expect(ssoErrorMessage("")).toBeNull();
  });
});
