// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stubApi } from "../../testing";
import { SkillUpdates } from "./skill-updates";

/** KOBE-318 ac-3: the builder shows skill updates and frozen versions runs leave out. */
const AGENT = "11111111-1111-4111-8111-111111111111";
const ROUTE = `GET /v1/agents/${AGENT}/skill-updates`;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const show = () => render(<SkillUpdates teamId="t-1" agentId={AGENT} version={3} />);

describe("SkillUpdates", () => {
  it("shows an update available and a blocklisted frozen version", async () => {
    stubApi({
      [ROUTE]: [
        200,
        {
          version: 3,
          skills: [
            {
              name: "house-style",
              frozen: { version: 1, semver: "1.2.0" },
              status: "blocklisted",
              update: { version: 2, semver: "1.3.0" },
            },
            {
              name: "brand",
              frozen: { version: 4, semver: "0.4.0" },
              status: "ok",
              update: null,
            },
          ],
        },
      ],
    });
    show();
    expect(
      await screen.findByText("house-style 1.2.0 is blocklisted: runs of v3 leave it out."),
    ).toBeTruthy();
    expect(
      screen.getByText(/Skill update available: house-style 1\.2\.0 → 1\.3\.0\. Publish again/),
    ).toBeTruthy();
    expect(screen.queryByText(/brand/)).toBeNull();
  });

  it("names a suspended frozen version, and a skill first usable since publish", async () => {
    stubApi({
      [ROUTE]: [
        200,
        {
          version: 3,
          skills: [
            {
              name: "sus",
              frozen: { version: 2, semver: "0.2.0" },
              status: "suspended",
              update: null,
            },
            {
              name: "later",
              frozen: null,
              status: "not_approved",
              update: { version: 1, semver: "0.1.0" },
            },
          ],
        },
      ],
    });
    show();
    expect(
      await screen.findByText("sus 0.2.0 is suspended after a rescan: runs of v3 leave it out."),
    ).toBeTruthy();
    expect(screen.getByText(/Skill update available: later 0\.1\.0\. Publish again/)).toBeTruthy();
  });

  it("says nothing when every frozen version is current, or on an error", async () => {
    stubApi({
      [ROUTE]: [
        200,
        {
          version: 3,
          skills: [
            { name: "brand", frozen: { version: 1, semver: "0.1.0" }, status: "ok", update: null },
          ],
        },
      ],
    });
    const { container } = show();
    await new Promise((r) => setTimeout(r, 20));
    expect(container.textContent).toBe("");
    cleanup();
    stubApi({});
    const again = show();
    await new Promise((r) => setTimeout(r, 20));
    expect(again.container.textContent).toBe("");
  });
});
