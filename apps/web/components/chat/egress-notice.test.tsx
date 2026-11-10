// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EgressRequest } from "../../lib/chat/types";
import { IconActionProvider } from "../shell/icon-action";
import { EgressNotice, requestForBlock } from "./egress-notice";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const wrapper = ({ children }: { readonly children: ReactNode }) => (
  <IconActionProvider>{children}</IconActionProvider>
);

const THREAD = "9a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const request = (status: EgressRequest["status"]): EgressRequest => ({
  id: "r1",
  domain: "pypi.org",
  pattern: "pypi.org",
  status,
  threadId: THREAD,
  createdAt: "2026-10-04T00:00:00Z",
  decidedAt: status === "pending" ? null : "2026-10-04T00:05:00Z",
});

function api(existing: EgressRequest[] = []) {
  return {
    egressRequests: vi.fn(async () => ({
      ok: true as const,
      status: 200,
      data: { requests: existing },
    })),
    requestEgressAccess: vi.fn(async () => ({
      ok: true as const,
      status: 201,
      data: { request: request("pending") },
    })),
  };
}

describe("EgressNotice (KOBE-39)", () => {
  it("offers no request for a domain outside the ceiling", () => {
    render(
      <EgressNotice
        payload={{ domain: "example.com", request_access: false }}
        api={api()}
        threadId={THREAD}
      />,
    );
    expect(screen.getByText(/outside what this site allows/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Request access/ })).toBeNull();
  });

  it("shows a decision read back on mount instead of the button", async () => {
    render(
      <EgressNotice
        payload={{ domain: "pypi.org", request_access: true }}
        api={api([request("approved")])}
        threadId={THREAD}
      />,
    );
    expect(await screen.findByText(/A team admin enabled pypi.org/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Request access/ })).toBeNull();
  });

  it("says a denial plainly", async () => {
    render(
      <EgressNotice
        payload={{ domain: "pypi.org", request_access: true }}
        api={api([request("denied")])}
        threadId={THREAD}
      />,
    );
    expect(await screen.findByText("A team admin denied access to pypi.org.")).toBeTruthy();
  });

  it("asks with the thread id, then re-reads the pending request until it is decided", async () => {
    const fake = api();
    render(
      <EgressNotice
        payload={{ domain: "pypi.org", request_access: true }}
        api={fake}
        threadId={THREAD}
        pollMs={20}
      />,
    );
    await userEvent.setup().click(await screen.findByRole("button", { name: /Request access/ }));
    expect(fake.requestEgressAccess).toHaveBeenCalledWith("pypi.org", THREAD, undefined);
    expect(await screen.findByText(/your team admins were notified/)).toBeTruthy();
    fake.egressRequests.mockResolvedValue({
      ok: true,
      status: 200,
      data: { requests: [request("approved")] },
    });
    expect(await screen.findByText(/A team admin enabled pypi.org/)).toBeTruthy();
  });

  it("handles 'already enabled' and errors from the server", async () => {
    const fake = api();
    fake.requestEgressAccess.mockResolvedValueOnce({
      ok: false,
      error: { status: 409, code: "already_enabled", message: "x" },
    } as never);
    render(
      <EgressNotice
        payload={{ domain: "pypi.org", request_access: true }}
        api={fake}
        threadId={THREAD}
      />,
    );
    await userEvent.setup().click(await screen.findByRole("button", { name: /Request access/ }));
    expect(await screen.findByText(/pypi.org is enabled for your team now/)).toBeTruthy();
    cleanup();
    fake.requestEgressAccess.mockResolvedValueOnce({
      ok: false,
      error: { status: 429, code: "too_many_requests", message: "Wait for your team admins." },
    } as never);
    render(
      <EgressNotice
        payload={{ domain: "pypi.org", request_access: true }}
        api={fake}
        threadId={THREAD}
      />,
    );
    await userEvent.setup().click(await screen.findByRole("button", { name: /Request access/ }));
    expect(await screen.findByText("Wait for your team admins.")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Request access/ })).toBeTruthy();
  });

  it("closes for this viewer by the event's id, stops polling, and stays closed (KOBE-468)", async () => {
    const fake = api([request("pending")]);
    const notice = (
      <EgressNotice
        payload={{ domain: "pypi.org", request_access: true }}
        api={fake}
        threadId={THREAD}
        pollMs={20}
        closeId="run-1:egress:pypi.org"
      />
    );
    const { unmount } = render(notice, { wrapper });
    expect(await screen.findByText(/your team admins were notified/)).toBeTruthy();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Close notice about pypi.org" }));
    expect(screen.queryByText(/was blocked/)).toBeNull();
    const calls = fake.egressRequests.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(fake.egressRequests.mock.calls.length).toBe(calls);
    expect(fake.requestEgressAccess).not.toHaveBeenCalled();
    unmount();
    render(notice, { wrapper });
    await waitFor(() => expect(screen.queryByText(/was blocked/)).toBeNull());
  });

  it("has no close button without an event id", () => {
    render(
      <EgressNotice
        payload={{ domain: "example.com", request_access: false }}
        api={api()}
        threadId={THREAD}
      />,
    );
    expect(screen.queryByRole("button")).toBeNull();
  });
});

type Viewer = { siteAdmin: boolean; teamAdmin: boolean; teamName: string };
const SITE: Viewer = { siteAdmin: true, teamAdmin: false, teamName: "Team1" };
const TEAM_ADMIN: Viewer = { siteAdmin: false, teamAdmin: true, teamName: "Team1" };
const MEMBER: Viewer = { siteAdmin: false, teamAdmin: false, teamName: "Team1" };

function adminApi(viewer: Viewer, existing: EgressRequest[] = []) {
  return {
    ...api(existing),
    egressViewer: vi.fn(async () => ({ ok: true as const, status: 200, data: viewer })),
    decideEgressRequest: vi.fn(async (_id: string, input: { pattern?: string | undefined }) => ({
      ok: true as const,
      status: 200,
      data: {
        request: request("approved"),
        settled: 1,
        enabled: true,
        pattern: input.pattern ?? "a.example.com",
        ceiling: "added" as const,
        internal: false,
      },
    })),
  };
}

const blocked = (reason: "not_enabled" | "not_in_ceiling" | "forbidden_address") => ({
  domain: "a.example.com",
  request_access: true,
  reason,
});

describe("EgressNotice: request access for every block and decisions in the card (KOBE-604)", () => {
  it.each([
    ["not_enabled", /Your team admins can allow it/],
    ["not_in_ceiling", /The site admins can allow it/],
    ["forbidden_address", /The site admins can allow it/],
  ] as const)("a member sees Request access and who decides for %s", async (reason, sentence) => {
    const fake = adminApi(MEMBER);
    render(<EgressNotice payload={blocked(reason)} api={fake} threadId={THREAD} />);
    expect(await screen.findByRole("button", { name: /Request access/ })).toBeTruthy();
    await waitFor(() => expect(fake.egressViewer).toHaveBeenCalled());
    expect(screen.getByText(sentence)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Approve/ })).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
    await userEvent.setup().click(screen.getByRole("button", { name: /Request access/ }));
    expect(fake.requestEgressAccess).toHaveBeenCalledWith("a.example.com", THREAD, reason);
  });

  it("says the site admins were notified for a site-scope request", async () => {
    const fake = adminApi(MEMBER, [{ ...request("pending"), scope: "site" }]);
    render(<EgressNotice payload={blocked("not_in_ceiling")} api={fake} threadId={THREAD} />);
    expect(await screen.findByText(/the site admins were notified/)).toBeTruthy();
  });

  it("a site admin approves an off-ceiling host: creates the request, then decides with the pattern", async () => {
    const fake = adminApi(SITE);
    render(<EgressNotice payload={blocked("not_in_ceiling")} api={fake} threadId={THREAD} />);
    const user = userEvent.setup();
    const select = await screen.findByRole("combobox", { name: /Allow/ });
    expect([...(select as HTMLSelectElement).options].map((o) => o.value)).toEqual([
      "a.example.com",
      "*.example.com",
    ]);
    expect((select as HTMLSelectElement).value).toBe("a.example.com");
    expect((screen.getByLabelText("Internal (same cluster)") as HTMLInputElement).checked).toBe(
      false,
    );
    await user.selectOptions(select, "*.example.com");
    await user.click(screen.getByLabelText("Internal (same cluster)"));
    await user.click(screen.getByRole("button", { name: /Approve/ }));
    expect(fake.requestEgressAccess).toHaveBeenCalledWith(
      "a.example.com",
      THREAD,
      "not_in_ceiling",
    );
    expect(fake.decideEgressRequest).toHaveBeenCalledWith("r1", {
      decision: "approve",
      pattern: "*.example.com",
      internal: true,
    });
    const status = await screen.findByText(
      "Enabled *.example.com for Team1. Ask the agent to try again.",
    );
    expect(status).toBe(document.activeElement);
    expect(screen.queryByRole("button", { name: /Approve/ })).toBeNull();
  });

  it("checks Internal by default for forbidden_address", async () => {
    const fake = adminApi(SITE);
    render(<EgressNotice payload={blocked("forbidden_address")} api={fake} threadId={THREAD} />);
    const box = (await screen.findByLabelText("Internal (same cluster)")) as HTMLInputElement;
    expect(box.checked).toBe(true);
    await userEvent.setup().click(screen.getByRole("button", { name: /Approve/ }));
    expect(fake.decideEgressRequest).toHaveBeenCalledWith("r1", {
      decision: "approve",
      internal: true,
    });
  });

  it("decides the member's pending request and can deny it", async () => {
    const pending = { ...request("pending"), domain: "a.example.com", pattern: "a.example.com" };
    const fake = adminApi(SITE, [{ ...pending, scope: "site" }]);
    render(<EgressNotice payload={blocked("not_in_ceiling")} api={fake} threadId={THREAD} />);
    await userEvent.setup().click(await screen.findByRole("button", { name: /Deny/ }));
    expect(fake.requestEgressAccess).not.toHaveBeenCalled();
    expect(fake.decideEgressRequest).toHaveBeenCalledWith("r1", { decision: "deny" });
    expect(await screen.findByText("Denied access to a.example.com for Team1.")).toBeTruthy();
  });

  it("offers a team admin Approve for a ceiling host, with no Internal box, defaulting to the ceiling pattern", async () => {
    const pending = {
      ...request("pending"),
      domain: "a.example.com",
      pattern: "*.example.com",
      scope: "team" as const,
    };
    const fake = adminApi(TEAM_ADMIN, [pending]);
    render(<EgressNotice payload={blocked("not_enabled")} api={fake} threadId={THREAD} />);
    const select = (await screen.findByRole("combobox", { name: /Allow/ })) as HTMLSelectElement;
    expect(select.value).toBe("*.example.com");
    expect(screen.queryByLabelText("Internal (same cluster)")).toBeNull();
    await userEvent.setup().click(screen.getByRole("button", { name: /Approve/ }));
    expect(fake.decideEgressRequest).toHaveBeenCalledWith("r1", { decision: "approve" });
  });

  it("gives a team admin only Request access off the ceiling", async () => {
    const fake = adminApi(TEAM_ADMIN);
    render(<EgressNotice payload={blocked("not_in_ceiling")} api={fake} threadId={THREAD} />);
    await waitFor(() => expect(fake.egressViewer).toHaveBeenCalled());
    expect(await screen.findByRole("button", { name: /Request access/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Approve/ })).toBeNull();
  });

  it("shows the server's refusal plainly and keeps the controls", async () => {
    const fake = adminApi(SITE);
    fake.decideEgressRequest.mockResolvedValueOnce({
      ok: false,
      error: { status: 422, code: "invalid_pattern", message: "That pattern is a public suffix." },
    } as never);
    render(<EgressNotice payload={blocked("not_in_ceiling")} api={fake} threadId={THREAD} />);
    await userEvent.setup().click(await screen.findByRole("button", { name: /Approve/ }));
    expect(await screen.findByText("That pattern is a public suffix.")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Approve/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Deny/ })).toBeTruthy();
  });

  it("shows the error when the admin's own request cannot be created", async () => {
    const fake = adminApi(SITE);
    fake.requestEgressAccess.mockResolvedValueOnce({
      ok: false,
      error: { status: 429, code: "too_many_requests", message: "Slow down." },
    } as never);
    render(<EgressNotice payload={blocked("not_in_ceiling")} api={fake} threadId={THREAD} />);
    await userEvent.setup().click(await screen.findByRole("button", { name: /Approve/ }));
    expect(await screen.findByText("Slow down.")).toBeTruthy();
    expect(fake.decideEgressRequest).not.toHaveBeenCalled();
  });
});

describe("EgressNotice: a decision older than the block is not its answer (KOBE-609)", () => {
  // request(): created 00:00, decided 00:05 on 2026-10-04.
  const AFTER = "2026-10-04T00:10:00Z";
  const BEFORE = "2026-10-04T00:01:00Z";
  const on = (domain = "pypi.org") => ({ domain, request_access: true });

  it.each(["approved", "denied"] as const)(
    "a block newer than an %s request offers Request access again",
    async (status) => {
      const fake = api([request(status)]);
      render(<EgressNotice payload={on()} blockedAt={AFTER} api={fake} threadId={THREAD} />);
      expect(await screen.findByRole("button", { name: /Request access/ })).toBeTruthy();
      await waitFor(() => expect(fake.egressRequests).toHaveBeenCalled());
      expect(screen.queryByText(/A team admin (enabled|denied)/)).toBeNull();
    },
  );

  it("an older block still shows the decision that answered it", async () => {
    render(
      <EgressNotice
        payload={on()}
        blockedAt={BEFORE}
        api={api([request("approved")])}
        threadId={THREAD}
      />,
    );
    expect(await screen.findByText(/A team admin enabled pypi.org/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Request access/ })).toBeNull();
  });

  it("a pending request shows pending whatever the block's time", async () => {
    render(
      <EgressNotice
        payload={on()}
        blockedAt={AFTER}
        api={api([request("pending")])}
        threadId={THREAD}
      />,
    );
    expect(await screen.findByText(/your team admins were notified/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Request access/ })).toBeNull();
  });

  it("without the block's time the latest request counts (older callers)", async () => {
    render(<EgressNotice payload={on()} api={api([request("approved")])} threadId={THREAD} />);
    expect(await screen.findByText(/A team admin enabled pypi.org/)).toBeTruthy();
  });

  it("a site admin gets Approve and Deny on a block newer than an approved request", async () => {
    const stale = { ...request("approved"), domain: "a.example.com", pattern: "a.example.com" };
    const fake = adminApi(SITE, [{ ...stale, scope: "site" }]);
    render(
      <EgressNotice
        payload={blocked("not_in_ceiling")}
        blockedAt={AFTER}
        api={fake}
        threadId={THREAD}
      />,
    );
    await waitFor(() => expect(fake.egressRequests).toHaveBeenCalled());
    await userEvent.setup().click(await screen.findByRole("button", { name: /Approve/ }));
    // The stale request is not re-decided: a new one is made for this block.
    expect(fake.requestEgressAccess).toHaveBeenCalledWith(
      "a.example.com",
      THREAD,
      "not_in_ceiling",
    );
    expect(fake.decideEgressRequest).toHaveBeenCalledWith("r1", { decision: "approve" });
    expect(
      await screen.findByText("Enabled a.example.com for Team1. Ask the agent to try again."),
    ).toBeTruthy();
  });
});

describe("requestForBlock (KOBE-609)", () => {
  it("keeps the latest unless it was decided before the block", () => {
    const approved = request("approved");
    expect(requestForBlock(approved, "2026-10-04T00:10:00Z")).toBeUndefined();
    expect(requestForBlock(approved, "2026-10-04T00:05:00Z")).toBe(approved);
    expect(requestForBlock(approved, undefined)).toBe(approved);
    expect(requestForBlock(approved, "not a time")).toBe(approved);
    expect(requestForBlock(request("pending"), "2030-01-01T00:00:00Z")?.status).toBe("pending");
    expect(requestForBlock(undefined, "2026-10-04T00:10:00Z")).toBeUndefined();
  });
});
