// @vitest-environment happy-dom
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SkillBlocklistPage } from "./site/skill-blocklist-page";
import { forbidNativeConfirm, answerConfirm, renderSite, stubApi } from "./testing";

const BASE = "/v1/site/skill-blocklist";
const H1 = "a".repeat(64);
const H2 = "b".repeat(64);
const entry = (contentHash: string, reason: string) => ({
  contentHash,
  reason,
  addedBy: "u-1",
  addedAt: "2026-10-04T10:00:00.000Z",
});

beforeEach(forbidNativeConfirm);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Skill blocklist (KOBE-81)", () => {
  it("lists hashes and pages with Load more", async () => {
    stubApi({
      [`GET ${BASE}`]: [200, { entries: [entry(H1, "malware")], nextCursor: "c1" }],
      [`GET ${BASE}?cursor=c1`]: [200, { entries: [entry(H2, "typosquat")], nextCursor: null }],
    });
    renderSite(<SkillBlocklistPage />);
    expect((await screen.findAllByText(H1)).length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect((await screen.findAllByText(H2)).length).toBeGreaterThan(0);
    expect(screen.getByText("malware")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("blocks a hash with a reason (lowercased) and reloads", async () => {
    const calls = stubApi({
      [`GET ${BASE}`]: [
        [200, { entries: [], nextCursor: null }],
        [200, { entries: [entry(H1, "bad bundle")], nextCursor: null }],
      ],
      [`POST ${BASE}`]: [201, { entry: entry(H1, "bad bundle") }],
    });
    renderSite(<SkillBlocklistPage />);
    expect(await screen.findByText("No hashes are blocked.")).toBeTruthy();
    await userEvent.type(screen.getByLabelText("Bundle hash (SHA-256)"), `  ${H1.toUpperCase()} `);
    await userEvent.type(screen.getByLabelText("Reason"), "bad bundle");
    await userEvent.click(screen.getByRole("button", { name: "Block hash" }));
    expect((await screen.findAllByText(H1)).length).toBeGreaterThan(0);
    const post = calls.find((c) => c.method === "POST");
    expect(JSON.parse(String(post?.body))).toEqual({ contentHash: H1, reason: "bad bundle" });
  });

  it("removes a hash after confirming", async () => {
    const calls = stubApi({
      [`GET ${BASE}`]: [
        [200, { entries: [entry(H1, "malware")], nextCursor: null }],
        [200, { entries: [], nextCursor: null }],
      ],
      [`DELETE ${BASE}/${H1}`]: [204],
    });
    renderSite(<SkillBlocklistPage />);
    await userEvent.click(await screen.findByRole("button", { name: `Remove ${H1}` }));
    await answerConfirm(`Remove ${H1.slice(0, 12)}… from the blocklist?`, "Cancel");
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: `Remove ${H1}` }));
    await answerConfirm(`Remove ${H1.slice(0, 12)}… from the blocklist?`, "Remove from blocklist");
    expect(await screen.findByText("No hashes are blocked.")).toBeTruthy();
    expect(calls.some((c) => c.method === "DELETE")).toBe(true);
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("heading", { name: "Blocked skill hashes" }),
      ),
    );
  });

  it("shows the server's error for a duplicate", async () => {
    stubApi({
      [`GET ${BASE}`]: [200, { entries: [], nextCursor: null }],
      [`POST ${BASE}`]: [
        409,
        { code: "already_blocked", message: "That hash is already blocked." },
      ],
    });
    renderSite(<SkillBlocklistPage />);
    await screen.findByText("No hashes are blocked.");
    await userEvent.type(screen.getByLabelText("Bundle hash (SHA-256)"), H1);
    await userEvent.type(screen.getByLabelText("Reason"), "x");
    await userEvent.click(screen.getByRole("button", { name: "Block hash" }));
    expect(await screen.findByText(/already blocked/)).toBeTruthy();
  });
});
