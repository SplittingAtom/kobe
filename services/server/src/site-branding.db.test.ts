import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BRANDING_ASSET_MAX_BYTES, siteBrandingSchema } from "@kobe/protocol";
import { REQUIRE_TWO_FACTOR } from "./auth/session.js";
import { readAppName } from "./branding/settings.js";
import { brandingCache } from "./branding/store.js";
import { RawBody, type TestBrowser } from "./testing/browser.js";
import {
  GRADIENT_SVG,
  REFUSED_SVGS,
  ico,
  jpeg,
  png,
  svg,
  webp,
  webpLossless,
  webpLossy,
} from "./testing/branding-fixtures.js";
import { PUBLIC_URL, openHarness, type Harness } from "./testing/harness.js";

/**
 * KOBE-499 (theming plan §4.2, TH4-TH8, TH12): the public branding GETs and the admin writes.
 */
let h: Harness;
let as: { owner: TestBrowser; admin: TestBrowser; alice: TestBrowser; anon: TestBrowser };

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const custom = (accent: string) => ({ preset: "custom", accent, corners: "soft", font: "system" });

function multipart(
  files: { name: string; data: Uint8Array; type?: string }[],
  fields: Record<string, string> = {},
) {
  const boundary = "----kobebranding";
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`),
    );
  }
  for (const f of files) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${f.name}"\r\n` +
          `Content-Type: ${f.type ?? "image/png"}\r\n\r\n`,
      ),
      Buffer.from(f.data),
      Buffer.from("\r\n"),
    );
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  const bytes = Buffer.concat(parts);
  return {
    raw: new RawBody(bytes, `multipart/form-data; boundary=${boundary}`),
    headers: { "content-length": String(bytes.length) },
  };
}

const upload = (b: TestBrowser, kind: string, data: Uint8Array, type?: string) => {
  const m = multipart([{ name: "file.bin", data, ...(type ? { type } : {}) }]);
  return b.request("PUT", `/v1/site/branding/assets/${kind}`, m.raw, m.headers);
};

/** audit_log is append-only: each test reads the events after this seq. */
let since = 0;

async function brandingEvents() {
  const { rows } = await h.admin.query<{ target: { setting: string; value: string } }>(
    `SELECT target FROM audit_log WHERE action = 'site.branding.updated' AND seq > $1 ORDER BY seq`,
    [since],
  );
  return rows.map((r) => r.target);
}

beforeAll(async () => {
  h = await openHarness();
  await h.createUser("owner@brand.test", "owner");
  await h.createUser("admin@brand.test", "admin");
  await h.createUser("alice@brand.test");
  as = {
    owner: await h.signIn("owner@brand.test"),
    admin: await h.signIn("admin@brand.test"),
    alice: await h.signIn("alice@brand.test"),
    anon: h.browser(),
  };
}, 120_000);

afterAll(() => h?.close());

beforeEach(async () => {
  await h.admin.query(`DELETE FROM site_branding_assets`);
  await h.admin.query(`DELETE FROM site_settings WHERE key LIKE 'branding.%'`);
  brandingCache(h.deps.database.db).invalidate();
  const { rows } = await h.admin.query<{ seq: string | null }>(
    `SELECT max(seq) AS seq FROM audit_log`,
  );
  since = Number(rows[0]?.seq ?? 0);
});

describe("GET /v1/site/branding (public, TH6)", () => {
  it("serves the defaults without a session, with an ETag and 304", async () => {
    const res = await as.anon.get("/v1/site/branding");
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      appName: "Kobe",
      showName: true,
      logo: null,
      favicon: null,
      theme: { preset: "default" },
    });
    expect(siteBrandingSchema.safeParse(res.json).success).toBe(true);
    expect(res.headers.get("cache-control")).toBe("no-cache");
    const etag = res.headers.get("etag");
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
    const again = await as.anon.get("/v1/site/branding", { "if-none-match": etag ?? "" });
    expect(again.status).toBe(304);
    expect(again.text).toBe("");
    expect((await as.anon.get("/v1/site/branding", { "if-none-match": `W/${etag}` })).status).toBe(
      304,
    );
    expect((await as.anon.get("/v1/site/branding", { "if-none-match": '"other"' })).status).toBe(
      200,
    );
  });

  it("reads fresh on every request: a write by another replica shows on the next read", async () => {
    const before = await as.anon.get("/v1/site/branding");
    // Written behind this replica's back (another server replica, the seed, a restore): no
    // per-replica cache, so the next read answers with it and the ETag moves.
    await h.admin.query(
      `INSERT INTO site_settings (key, value) VALUES ('branding.app_name', 'Other replica')`,
    );
    const after = await as.anon.get("/v1/site/branding");
    expect(after.json.appName).toBe("Other replica");
    expect(after.headers.get("etag")).not.toBe(before.headers.get("etag"));
    const put = await as.admin.put("/v1/site/branding", { appName: "Acme" });
    expect(put.json.appName).toBe("Acme");
    expect((await as.anon.get("/v1/site/branding")).json.appName).toBe("Acme");
  });

  it("falls back to the defaults on an unreadable stored value", async () => {
    await h.admin.query(
      `INSERT INTO site_settings (key, value) VALUES ('branding.theme', '{"preset":"neon"}'),
         ('branding.show_name', 'maybe'), ('branding.app_name', '')`,
    );
    expect((await as.anon.get("/v1/site/branding")).json).toMatchObject({
      appName: "Kobe",
      showName: true,
      theme: { preset: "default" },
    });
  });
});

describe("PUT /v1/site/branding", () => {
  it("needs site.settings.manage, a session and the site's origin", async () => {
    expect((await as.alice.put("/v1/site/branding", { appName: "X" })).status).toBe(403);
    expect((await as.anon.put("/v1/site/branding", { appName: "X" })).status).toBe(401);
    const cross = await as.admin.put(
      "/v1/site/branding",
      { appName: "X" },
      { origin: "https://evil.test" },
    );
    expect(cross.status).toBe(403);
    expect(cross.json.code).toBe("forbidden_origin");
    for (const path of ["/v1/site/branding/reset"]) {
      expect((await as.alice.post(path)).status).toBe(403);
    }
    expect((await as.alice.delete("/v1/site/branding/assets/logo")).status).toBe(403);
    expect((await upload(as.alice, "logo", png())).status).toBe(403);
    expect(await brandingEvents()).toEqual([]);
  });

  it("validates strictly and needs at least one field", async () => {
    for (const bad of [
      {},
      { appName: "" },
      { appName: "x".repeat(41) },
      { appName: "a‮b" },
      { showName: "yes" },
      { theme: { preset: "neon" } },
      { theme: { preset: "custom", accent: "#ABCDEF", corners: "soft", font: "system" } },
      { css: "body{}" },
    ]) {
      const res = await as.admin.put("/v1/site/branding", bad);
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect(res.json.code).toBe("invalid_request");
    }
  });

  it("stores the name, showName and theme, one audit event per changed setting", async () => {
    const res = await as.owner.put("/v1/site/branding", {
      appName: "  Acme Analytics ",
      showName: false,
      theme: { preset: "tokyo-nights" },
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json).toMatchObject({
      appName: "Acme Analytics",
      showName: false,
      theme: { preset: "tokyo-nights" },
    });
    await as.admin.put("/v1/site/branding", {
      appName: "Acme Analytics",
      theme: custom("#2449c7"),
    });
    expect(await brandingEvents()).toEqual([
      { setting: "app_name", value: "Acme Analytics" },
      { setting: "show_name", value: "false" },
      { setting: "theme", value: "theme:tokyo-nights" },
      { setting: "theme", value: "theme:custom #2449c7" },
    ]);
    expect(await readAppName(h.deps.database.db)).toBe("Acme Analytics");
  });

  it("refuses an accent under the contrast floor with the ratio (TH4)", async () => {
    const res = await as.admin.put("/v1/site/branding", { theme: custom("#777777") });
    expect(res.status).toBe(422);
    expect(res.json.code).toBe("contrast_floor");
    expect(res.json.message).toMatch(/4\.\d+:1, needs 4\.5:1/);
    expect(res.json.failures[0]).toMatchObject({
      rule: "fg_on_primary",
      scheme: "light",
      required: 4.5,
    });
    expect(res.json.failures[0].ratio).toBeLessThan(4.5);
    expect((await as.admin.put("/v1/site/branding", { theme: custom("#15803d") })).status).toBe(
      200,
    );
  });
});

describe("branding files", () => {
  it.each([
    ["logo", "PNG", png(300, 120), "image/png"],
    ["logo", "JPEG", jpeg(64, 32), "image/jpeg"],
    ["logo", "WebP (VP8X)", webp(20, 10), "image/webp"],
    ["logo_dark", "WebP (VP8)", webpLossy(20, 10), "image/webp"],
    ["logo_dark", "WebP (VP8L)", webpLossless(20, 10), "image/webp"],
    ["logo", "SVG", svg(), "image/svg+xml"],
    ["logo", "SVG with url(#gradient) styles", GRADIENT_SVG, "image/svg+xml"],
    ["favicon", "ICO", ico(), "image/x-icon"],
    ["favicon", "SVG", svg(), "image/svg+xml"],
    ["favicon", "PNG", png(32, 32), "image/png"],
  ] as const)("stores a %s %s from its bytes and serves it", async (kind, _name, data, type) => {
    // The declared part type is ignored: the bytes decide.
    const res = await upload(as.admin, kind, data, "text/html");
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const digest = sha(data);
    const { rows } = await h.admin.query<{
      content_type: string;
      sha256: string;
      byte_size: number;
      updated_by: string | null;
    }>(
      `SELECT content_type, sha256, byte_size, updated_by FROM site_branding_assets WHERE kind = $1`,
      [kind],
    );
    expect(rows[0]).toMatchObject({ content_type: type, sha256: digest, byte_size: data.length });
    expect(rows[0]?.updated_by).not.toBeNull();
    const url = `/v1/site/branding/assets/${kind}?v=${digest}`;
    if (kind === "favicon") expect(res.json.favicon).toBe(url);
    if (kind === "logo") expect(res.json.logo).toMatchObject({ url });
    expect(siteBrandingSchema.safeParse(res.json).success).toBe(true);
    const served = await as.anon.get(url);
    expect(served.status).toBe(200);
    expect(Buffer.from(served.bytes).equals(Buffer.from(data))).toBe(true);
    expect(served.headers.get("content-type")).toBe(type);
    expect(served.headers.get("x-content-type-options")).toBe("nosniff");
    expect(served.headers.get("content-security-policy")).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    );
    expect(served.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(await brandingEvents()).toEqual([{ setting: kind, value: digest }]);
  });

  it("caches immutably only when ?v matches; otherwise no-cache with ETag and 304", async () => {
    const data = png();
    await upload(as.admin, "logo", data);
    const digest = sha(data);
    for (const query of ["", "?v=", `?v=${"0".repeat(64)}`]) {
      const res = await as.anon.get(`/v1/site/branding/assets/logo${query}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control"), query).toBe("no-cache");
      expect(res.headers.get("etag")).toBe(`"${digest}"`);
    }
    const cached = await as.anon.get("/v1/site/branding/assets/logo", {
      "if-none-match": `"${digest}"`,
    });
    expect(cached.status).toBe(304);
    expect(cached.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await as.anon.get("/v1/site/branding/assets/logo_dark")).status).toBe(404);
    expect((await as.anon.get("/v1/site/branding/assets/banner")).status).toBe(404);
  });

  it("shows the dark logo only next to a light one", async () => {
    await upload(as.admin, "logo_dark", png());
    expect((await as.anon.get("/v1/site/branding")).json.logo).toBeNull();
    await upload(as.admin, "logo", svg());
    expect((await as.anon.get("/v1/site/branding")).json.logo).toEqual({
      url: `/v1/site/branding/assets/logo?v=${sha(svg())}`,
      // The box for layout: the SVG's viewBox, the PNG's pixels.
      width: 10,
      height: 10,
      dark: `/v1/site/branding/assets/logo_dark?v=${sha(png())}`,
      darkWidth: 2,
      darkHeight: 2,
    });
  });

  it("refuses by Content-Length before reading the body (413)", async () => {
    let pulled = false;
    const body = new ReadableStream<Uint8Array>(
      {
        pull() {
          pulled = true;
          throw new Error("the body must not be read");
        },
      },
      // No read-ahead: pull() runs only when someone reads.
      { highWaterMark: 0 },
    );
    const cookie = [...as.admin.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await h.app.request(`${PUBLIC_URL}/v1/site/branding/assets/favicon`, {
      method: "PUT",
      headers: {
        origin: PUBLIC_URL,
        cookie,
        "content-type": "multipart/form-data; boundary=x",
        "content-length": String(BRANDING_ASSET_MAX_BYTES.favicon + 64 * 1024),
      },
      body,
      duplex: "half",
    } as RequestInit);
    expect(res.status).toBe(413);
    expect(((await res.json()) as { code: string }).code).toBe("file_too_large");
    expect(pulled).toBe(false);
  });

  it("refuses a file over the cap inside a small enough body, and needs Content-Length", async () => {
    // Over the favicon cap but under cap + multipart allowance: refused while reading.
    const big = new Uint8Array(BRANDING_ASSET_MAX_BYTES.favicon + 10);
    big.set(png(), 0);
    const res = await upload(as.admin, "favicon", big);
    expect(res.status).toBe(413);
    expect(res.json.code).toBe("file_too_large");
  });

  it("refuses a request that is not exactly one file", async () => {
    const two = multipart([
      { name: "a.png", data: png() },
      { name: "b.png", data: png() },
    ]);
    expect(
      (await as.admin.request("PUT", "/v1/site/branding/assets/logo", two.raw, two.headers)).status,
    ).toBe(400);
    const none = multipart([]);
    expect(
      (await as.admin.request("PUT", "/v1/site/branding/assets/logo", none.raw, none.headers))
        .status,
    ).toBe(400);
    const field = multipart([{ name: "a.png", data: png() }], { extra: "1" });
    expect(
      (await as.admin.request("PUT", "/v1/site/branding/assets/logo", field.raw, field.headers))
        .status,
    ).toBe(400);
    const json = await as.admin.put("/v1/site/branding/assets/logo", { file: "x" });
    expect(json.status).toBe(415);
    expect((await upload(as.admin, "banner", png())).status).toBe(404);
    expect(await brandingEvents()).toEqual([]);
  });

  it("refuses wrong types per kind and images over 4096 px, naming the rule", async () => {
    const jpegFavicon = await upload(as.admin, "favicon", jpeg());
    expect(jpegFavicon.status).toBe(415);
    expect(jpegFavicon.json).toMatchObject({ code: "unsupported_type" });
    expect((await upload(as.admin, "logo", ico())).status).toBe(415);
    expect((await upload(as.admin, "logo", new TextEncoder().encode("GIF89a hello"))).status).toBe(
      415,
    );
    const huge = await upload(as.admin, "logo", png(5000, 10));
    expect(huge.status).toBe(422);
    expect(huge.json).toMatchObject({ code: "image_too_large", message: /4096 px/ });
    expect((await h.admin.query(`SELECT 1 FROM site_branding_assets`)).rowCount).toBe(0);
  });

  it.each(REFUSED_SVGS)("refuses an SVG with $name, with the reason", async ({ bytes, reason }) => {
    const res = await upload(as.admin, "logo", bytes, "image/svg+xml");
    expect(res.status).toBe(422);
    expect(res.json.code).toBe("svg_refused");
    expect(res.json.message).toMatch(reason);
  });

  it("deletes a file, audited; 404 when there is none", async () => {
    await upload(as.admin, "favicon", ico());
    const res = await as.admin.delete("/v1/site/branding/assets/favicon");
    expect(res.status).toBe(200);
    expect(res.json.favicon).toBeNull();
    expect((await as.admin.delete("/v1/site/branding/assets/favicon")).status).toBe(404);
    expect((await brandingEvents()).at(-1)).toEqual({ setting: "favicon", value: "removed" });
    expect((await as.anon.get("/v1/site/branding/assets/favicon")).status).toBe(404);
  });
});

describe("POST /v1/site/branding/reset (TH12)", () => {
  it("removes the name, files and style, audited per setting", async () => {
    await as.admin.put("/v1/site/branding", {
      appName: "Acme",
      showName: false,
      theme: { preset: "forest" },
    });
    for (const [kind, data] of [
      ["logo", png()],
      ["logo_dark", webp()],
      ["favicon", ico()],
    ] as const) {
      await upload(as.admin, kind, data);
    }
    const before = (await brandingEvents()).length;
    const res = await as.owner.post("/v1/site/branding/reset");
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      appName: "Kobe",
      showName: true,
      logo: null,
      favicon: null,
      theme: { preset: "default" },
    });
    expect((await brandingEvents()).slice(before)).toEqual([
      { setting: "app_name", value: "Kobe" },
      { setting: "show_name", value: "true" },
      { setting: "theme", value: "theme:default" },
      { setting: "logo", value: "removed" },
      { setting: "logo_dark", value: "removed" },
      { setting: "favicon", value: "removed" },
    ]);
    expect((await h.admin.query(`SELECT 1 FROM site_branding_assets`)).rowCount).toBe(0);
    // Nothing left to reset: nothing audited.
    await as.owner.post("/v1/site/branding/reset");
    expect((await brandingEvents()).length).toBe(before + 6);
  });

  it("leaves every other site setting untouched", async () => {
    await h.admin.query(
      `INSERT INTO site_settings (key, value) VALUES ('audit.pii_retention_hours', '48'),
         ($1, 'false') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [REQUIRE_TWO_FACTOR],
    );
    try {
      await as.admin.put("/v1/site/branding", { appName: "Acme" });
      expect((await as.owner.post("/v1/site/branding/reset")).status).toBe(200);
      const { rows } = await h.admin.query<{ key: string; value: string }>(
        `SELECT key, value FROM site_settings WHERE key IN ('audit.pii_retention_hours', $1) ORDER BY key`,
        [REQUIRE_TWO_FACTOR],
      );
      expect(rows).toEqual(
        [
          { key: "audit.pii_retention_hours", value: "48" },
          { key: REQUIRE_TWO_FACTOR, value: "false" },
        ].sort((a, b) => a.key.localeCompare(b.key)),
      );
    } finally {
      await h.admin.query(
        `DELETE FROM site_settings WHERE key IN ('audit.pii_retention_hours', $1)`,
        [REQUIRE_TWO_FACTOR],
      );
    }
  });

  it("is one transaction: a failure at the last step keeps everything", async () => {
    await as.admin.put("/v1/site/branding", { appName: "Acme", theme: { preset: "plum" } });
    await upload(as.admin, "favicon", ico());
    await h.admin.query(`
      CREATE FUNCTION branding_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.action = 'site.branding.updated' AND NEW.target->>'setting' = 'favicon' THEN
          RAISE EXCEPTION 'injected failure';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER branding_test_fail BEFORE INSERT ON audit_log
        FOR EACH ROW EXECUTE FUNCTION branding_test_fail();`);
    try {
      const res = await as.admin.post("/v1/site/branding/reset");
      expect(res.status).toBe(500);
    } finally {
      await h.admin.query(
        `DROP TRIGGER branding_test_fail ON audit_log; DROP FUNCTION branding_test_fail();`,
      );
    }
    const { rows } = await h.admin.query<{ key: string }>(
      `SELECT key FROM site_settings WHERE key LIKE 'branding.%' ORDER BY key`,
    );
    expect(rows.map((r) => r.key)).toEqual(["branding.app_name", "branding.theme"]);
    expect((await h.admin.query(`SELECT 1 FROM site_branding_assets`)).rowCount).toBe(1);
    expect((await as.anon.get("/v1/site/branding")).json.appName).toBe("Acme");
  });
});

describe("storage and grants", () => {
  it("lets the app role read and write the branding table, which has no team column", async () => {
    const role = decodeURIComponent(new URL(h.appUrl).username);
    const { rows } = await h.admin.query<{ privilege: string; granted: boolean }>(
      `SELECT p AS privilege, has_table_privilege($1, 'site_branding_assets', p) AS granted
         FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) AS p`,
      [role],
    );
    expect(rows.every((r) => r.granted)).toBe(true);
    const owner = await h.admin.query<{ owner: string }>(
      `SELECT tableowner AS owner FROM pg_tables WHERE tablename = 'site_branding_assets'`,
    );
    expect(owner.rows[0]?.owner).not.toBe(role);
    const cols = await h.admin.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 'site_branding_assets' AND column_name = 'team_id'`,
    );
    expect(cols.rowCount).toBe(0);
  });
});

describe("mail uses the configured name (ac-4)", () => {
  it("names the site in invitation and password reset mails", async () => {
    await as.admin.put("/v1/site/branding", { appName: "Acme Data" });
    expect((await as.admin.post("/v1/site/invites", { email: "nina@brand.test" })).status).toBe(
      201,
    );
    await h.browser().post("/api/auth/request-password-reset", { email: "alice@brand.test" });
    await h.mailer.settle();
    const invite = h.mailer.to("nina@brand.test").at(-1);
    expect(invite?.subject).toMatch(/invited you to Acme Data$/);
    const reset = h.mailer.to("alice@brand.test").at(-1);
    expect(reset?.subject).toBe("Reset your Acme Data password");
    for (const m of [invite, reset]) expect(`${m?.subject}\n${m?.text}`).not.toContain("Kobe");
  });
});
