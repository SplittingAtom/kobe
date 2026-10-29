// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { must } from "../../../testing/must";
import {
  getBranding,
  putBranding,
  removeBrandingAsset,
  resetBranding,
  uploadBrandingAsset,
} from "./branding";

const BRANDING = {
  appName: "Acme",
  showName: true,
  logo: null,
  favicon: null,
  theme: { preset: "default" },
};

function stub(status: number, body: unknown) {
  const fetchFn = vi.fn(
    async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify(body), { status }),
  );
  vi.stubGlobal("fetch", fetchFn);
  return fetchFn;
}

afterEach(() => vi.unstubAllGlobals());

describe("site branding client", () => {
  it("reads the public branding", async () => {
    const fetchFn = stub(200, BRANDING);
    const res = await getBranding();
    expect(res).toEqual({ ok: true, status: 200, data: BRANDING });
    expect(must(fetchFn.mock.calls[0])[0]).toBe("/v1/site/branding");
  });

  it("sends only the changed settings", async () => {
    const fetchFn = stub(200, BRANDING);
    await putBranding({ appName: "Acme", theme: { preset: "plum" } });
    const [url, init] = must(fetchFn.mock.calls[0]);
    expect(url).toBe("/v1/site/branding");
    expect(init?.method).toBe("PUT");
    expect(JSON.parse(String(init?.body))).toEqual({ appName: "Acme", theme: { preset: "plum" } });
  });

  it("keeps the contrast failures of a 422", async () => {
    const failures = [{ rule: "fg_on_primary", scheme: "light", ratio: 3.1, required: 4.5 }];
    stub(422, { code: "contrast_floor", message: "This accent does not reach…", failures });
    const res = await putBranding({
      theme: { preset: "custom", accent: "#777777", corners: "soft", font: "system" },
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("contrast_floor");
    expect(res.error.message).toBe("This accent does not reach…");
    expect(res.failures).toEqual(failures);
  });

  it("ignores a malformed failures list", async () => {
    stub(422, { code: "contrast_floor", message: "No.", failures: [{ rule: 3 }] });
    const res = await putBranding({ showName: false });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.failures).toEqual([]);
  });

  it("uploads one file as multipart under the kind", async () => {
    const fetchFn = stub(200, BRANDING);
    const file = new File([new Uint8Array([137, 80, 78, 71])], "logo.png", { type: "image/png" });
    await uploadBrandingAsset("logo_dark", file);
    const [url, init] = must(fetchFn.mock.calls[0]);
    expect(url).toBe("/v1/site/branding/assets/logo_dark");
    expect(init?.method).toBe("PUT");
    const form = init?.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect((form.get("file") as File).name).toBe("logo.png");
  });

  it("removes a file and resets everything", async () => {
    const fetchFn = stub(200, BRANDING);
    await removeBrandingAsset("favicon");
    await resetBranding();
    expect(fetchFn.mock.calls.map(([u, i]) => `${i?.method} ${u}`)).toEqual([
      "DELETE /v1/site/branding/assets/favicon",
      "POST /v1/site/branding/reset",
    ]);
  });
});
