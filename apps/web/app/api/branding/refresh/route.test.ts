import { afterEach, describe, expect, it, vi } from "vitest";

const invalidateBranding = vi.fn(async () => undefined);
vi.mock("../../../../lib/theme/branding-server", () => ({ invalidateBranding }));

const { POST } = await import("./route");

const request = (headers: Record<string, string>) =>
  new Request("http://web:3000/api/branding/refresh", { method: "POST", headers });

afterEach(() => invalidateBranding.mockClear());

describe("web /api/branding/refresh (KOBE-501)", () => {
  it("refetches the branding for a same-origin request: 204", async () => {
    const res = await POST(request({ "sec-fetch-site": "same-origin" }));
    expect(res.status).toBe(204);
    expect(invalidateBranding).toHaveBeenCalledTimes(1);
  });

  it("accepts a matching Origin when the browser sends no Sec-Fetch-Site", async () => {
    const res = await POST(
      request({ origin: "https://kobe.example.org", host: "kobe.example.org" }),
    );
    expect(res.status).toBe(204);
  });

  it.each([
    [{ "sec-fetch-site": "cross-site" }],
    [{ "sec-fetch-site": "same-site" }],
    [{ origin: "https://evil.example", host: "kobe.example.org" }],
    [{ host: "kobe.example.org" }],
    [{ origin: "null", host: "kobe.example.org" }],
  ])("refuses anything else: 403 (%o)", async (headers) => {
    const res = await POST(request(headers));
    expect(res.status).toBe(403);
    expect(invalidateBranding).not.toHaveBeenCalled();
  });
});
