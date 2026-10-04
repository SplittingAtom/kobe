// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EgressRequest } from "../../lib/chat/types";
import { EgressNotice } from "./egress-notice";

afterEach(cleanup);

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
    expect(screen.getByText(/outside what this install allows/)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
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
    expect(screen.queryByRole("button")).toBeNull();
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
    expect(fake.requestEgressAccess).toHaveBeenCalledWith("pypi.org", THREAD);
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
});
