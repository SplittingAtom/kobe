// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { answerConfirm, forbidNativeConfirm, stubApi } from "../admin/testing";
import { MySubmissions } from "./my-submissions";

/** KOBE-334 (ac-3): Request changes comes back to the author's Workbench with the note. */
beforeEach(() => forbidNativeConfirm());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("My Site submissions", () => {
  it("shows each state and the reviewer's note", async () => {
    stubApi({
      "GET /v1/me/skill-submissions": [
        200,
        {
          submissions: [
            {
              id: "v-1",
              name: "needs-work",
              semver: "0.1.0",
              state: "changes_requested",
              submitted_at: "2026-10-19T10:00:00Z",
              updated_at: "2026-10-19T11:00:00Z",
              notes: [
                {
                  action: "changes_requested",
                  note: "Explain the script.",
                  at: "2026-10-19T11:00:00Z",
                },
              ],
            },
            {
              id: "v-2",
              name: "good-one",
              semver: "1.0.0",
              state: "approved",
              submitted_at: "2026-10-18T10:00:00Z",
              updated_at: "2026-10-18T11:00:00Z",
              self_approved: true,
              notes: [],
            },
          ],
        },
      ],
    });
    render(<MySubmissions />);
    expect(await screen.findByText("Changes requested")).toBeTruthy();
    expect(screen.getByText("Explain the script.")).toBeTruthy();
    expect(screen.getByText(/save a new version and promote it again/)).toBeTruthy();
    expect(screen.getByText("In the Site catalog")).toBeTruthy();
    expect(screen.getByText("Self-approved")).toBeTruthy();
  });

  it("withdraws an open submission after confirming", async () => {
    const calls = stubApi({
      "GET /v1/me/skill-submissions": [
        200,
        {
          submissions: [
            {
              id: "v-1",
              name: "needs-work",
              semver: "0.1.0",
              state: "changes_requested",
              submitted_at: "2026-10-19T10:00:00Z",
              updated_at: "2026-10-19T11:00:00Z",
              self_approved: false,
              notes: [],
            },
          ],
        },
      ],
      "POST /v1/me/skill-submissions/v-1/retract": [200, { id: "v-1", state: "retracted" }],
    });
    render(<MySubmissions />);
    await userEvent.click(await screen.findByRole("button", { name: "Withdraw" }));
    await answerConfirm(/Withdraw needs-work 0\.1\.0/, "Withdraw");
    await waitFor(() =>
      expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/retract"))).toBe(true),
    );
  });
});
