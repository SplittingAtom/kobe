import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeEach, describe, expect, inject, it } from "vitest";

/**
 * KOBE-497 (theming TH7): `site_branding_assets` holds the site's logo, dark logo and favicon as
 * bytea, one row per kind. Site-wide like `site_settings` (no team_id, no RLS); the app role has
 * full privileges (the server lets only `site.settings.manage` write).
 */
const app = new pg.Client({ connectionString: inject("appUrl") });
await app.connect();
afterAll(() => app.end());

let userId = "";
beforeEach(async () => {
  await app.query(`DELETE FROM site_branding_assets`);
  userId = randomUUID();
  await app.query(`INSERT INTO users (id, name, email) VALUES ($1, 'B', $2)`, [
    userId,
    `${userId}@b.test`,
  ]);
});

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

const put = (kind: string, bytes = png, by: string | null = userId) =>
  app.query(
    `INSERT INTO site_branding_assets (kind, bytes, content_type, sha256, byte_size, width, height, updated_by)
     VALUES ($1, $2, 'image/png', $3, $4, 16, 16, $5)
     ON CONFLICT (kind) DO UPDATE SET bytes = EXCLUDED.bytes, sha256 = EXCLUDED.sha256,
       byte_size = EXCLUDED.byte_size, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [kind, bytes, sha(bytes), bytes.length, by],
  );

describe("site_branding_assets", () => {
  it("lets the app role store, replace, read and delete one row per kind", async () => {
    for (const kind of ["logo", "logo_dark", "favicon"]) await put(kind);
    const other = Buffer.from("<svg/>");
    await put("logo", other);
    const { rows } = await app.query<{ kind: string; bytes: Buffer; sha256: string }>(
      `SELECT kind, bytes, sha256 FROM site_branding_assets ORDER BY kind`,
    );
    expect(rows.map((r) => r.kind)).toEqual(["favicon", "logo", "logo_dark"]);
    expect(rows.find((r) => r.kind === "logo")?.bytes.equals(other)).toBe(true);
    expect(rows.find((r) => r.kind === "logo")?.sha256).toBe(sha(other));
    await app.query(`DELETE FROM site_branding_assets WHERE kind = 'logo_dark'`);
    expect((await app.query(`SELECT 1 FROM site_branding_assets`)).rowCount).toBe(2);
  });

  it.each(["banner", "Logo", ""])("refuses the kind %j", async (kind) => {
    await expect(put(kind)).rejects.toMatchObject({ code: "23514" });
  });

  it("allows null width and height (SVG, ICO) and a null writer", async () => {
    await app.query(
      `INSERT INTO site_branding_assets (kind, bytes, content_type, sha256, byte_size)
       VALUES ('favicon', $1, 'image/x-icon', $2, $3)`,
      [png, sha(png), png.length],
    );
    const { rows } = await app.query(
      `SELECT width, height, updated_by, updated_at IS NOT NULL AS stamped FROM site_branding_assets`,
    );
    expect(rows[0]).toEqual({ width: null, height: null, updated_by: null, stamped: true });
  });

  it("requires the bytes and their metadata, and a real writer", async () => {
    await expect(
      app.query(
        `INSERT INTO site_branding_assets (kind, content_type, sha256, byte_size)
         VALUES ('logo', 'image/png', 'x', 1)`,
      ),
    ).rejects.toMatchObject({ code: "23502" });
    await expect(put("logo", png, randomUUID())).rejects.toMatchObject({ code: "23503" });
  });

  it("keeps byte_size the real length, the sha256 a hex digest, and the limits (TH7)", async () => {
    const insert = (
      size: number,
      digest: string,
      side: number | null = 16,
      kind = "logo",
      bytes = png,
    ) =>
      app.query(
        `INSERT INTO site_branding_assets (kind, bytes, content_type, sha256, byte_size, width, height)
         VALUES ($1, $2, 'image/png', $3, $4, $5, $5)`,
        [kind, bytes, digest, size, side],
      );
    const fail = { code: "23514" };
    await expect(insert(png.length + 1, sha(png))).rejects.toMatchObject(fail);
    await expect(insert(png.length, "ABC")).rejects.toMatchObject(fail);
    await expect(insert(png.length, sha(png).toUpperCase())).rejects.toMatchObject(fail);
    await expect(insert(png.length, sha(png), 0)).rejects.toMatchObject(fail);
    await expect(insert(png.length, sha(png), 4097)).rejects.toMatchObject(fail);
    const big = Buffer.alloc(256 * 1024 + 1);
    await expect(insert(big.length, sha(big), 16, "favicon", big)).rejects.toMatchObject(fail);
    const huge = Buffer.alloc(512 * 1024 + 1);
    await expect(insert(huge.length, sha(huge), 16, "logo", huge)).rejects.toMatchObject(fail);
    await insert(png.length, sha(png), 4096);
    const max = Buffer.alloc(512 * 1024);
    await insert(max.length, sha(max), 16, "logo_dark", max);
  });

  it.each([
    ["logo", "image/x-icon"],
    ["logo_dark", "image/x-icon"],
    ["favicon", "image/jpeg"],
    ["favicon", "image/webp"],
    ["logo", "text/html"],
    ["logo", "image/PNG"],
    ["favicon", "image/svg+xml; charset=utf-8"],
  ])("refuses %s as %s", async (kind, type) => {
    await expect(
      app.query(
        `INSERT INTO site_branding_assets (kind, bytes, content_type, sha256, byte_size)
         VALUES ($1, $2, $3, $4, $5)`,
        [kind, png, type, sha(png), png.length],
      ),
    ).rejects.toMatchObject({ code: "23514", constraint: "site_branding_assets_content_type" });
  });

  it("accepts each kind's allowed content types", async () => {
    const allowed: Record<string, string[]> = {
      logo: ["image/png", "image/jpeg", "image/webp", "image/svg+xml"],
      logo_dark: ["image/png", "image/jpeg", "image/webp", "image/svg+xml"],
      favicon: ["image/png", "image/svg+xml", "image/x-icon"],
    };
    for (const [kind, types] of Object.entries(allowed))
      for (const type of types) {
        await app.query(
          `INSERT INTO site_branding_assets (kind, bytes, content_type, sha256, byte_size)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (kind) DO UPDATE SET content_type = EXCLUDED.content_type`,
          [kind, png, type, sha(png), png.length],
        );
      }
  });
});
