import { describe, expect, it } from "vitest";
import { teamAuditList } from "../team-reports.js";
import { siteConnectorsList } from "./models.js";
import { publicUrl, sameValues } from "./shared.js";

/** Security review of KA-4/5/6 (KOBE-623 follow-up): bounded, credential-free tool output. */

describe("team_audit_list strips client details at any depth", () => {
  it("drops ip/userAgent nested in the target, like the site tool", () => {
    const out = teamAuditList.reduce(
      {
        events: [
          {
            seq: 3,
            at: "2026-11-11T00:00:00.000Z",
            actor: { kind: "user", id: "u", name: "Ana" },
            action: "x.y",
            target: {
              ip: "1.2.3.4",
              nested: { userAgent: "UA", keep: 1, deeper: { ip_address: "x" } },
            },
          },
        ],
        nextCursor: null,
      },
      {},
    ) as { events: { target: Record<string, unknown> }[] };
    expect(out.events[0]?.target).toEqual({ nested: { keep: 1, deeper: {} } });
  });
});

describe("site_connectors_list returns URLs without credentials", () => {
  it.each([
    ["https://user:pw@api.example.com/mcp?api_key=s3cret&x=1#f", "https://api.example.com/mcp"],
    ["https://api.example.com/v1/mcp/?token=abc", "https://api.example.com/v1/mcp/"],
    [
      "http://kobe-server.internal/internal/v1/mcp/kobe",
      "http://kobe-server.internal/internal/v1/mcp/kobe",
    ],
    ["not a url", "(not shown)"],
  ])("%s → %s", (url, shown) => {
    expect(publicUrl(url)).toBe(shown);
  });

  it("applies it to every listed connector", () => {
    const out = siteConnectorsList.reduce(
      {
        connectors: [
          {
            id: "00000000-0000-4000-8000-000000000001",
            name: "jira",
            url: "https://bot:pw@jira.example.com/mcp?secret=1",
            authKind: "api_key",
            credentialSource: "site",
            status: "active",
            toolCount: 1,
            driftedCount: 0,
          },
        ],
      },
      {},
    ) as { connectors: { url: string }[] };
    expect(out.connectors[0]?.url).toBe("https://jira.example.com/mcp");
  });
});

describe("before-state comparison", () => {
  it("is independent of key order (a theme object read back in another order)", () => {
    expect(
      sameValues(
        { theme: { preset: "custom", accent: "#112233", corners: "round" } },
        { theme: { corners: "round", accent: "#112233", preset: "custom" } },
      ),
    ).toBe(true);
    expect(sameValues({ theme: { accent: "#112233" } }, { theme: { accent: "#445566" } })).toBe(
      false,
    );
    expect(sameValues({ a: undefined, b: 1 }, { b: 1 })).toBe(true);
  });
});
