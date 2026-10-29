import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { Hono, type Context } from "hono";
import { z } from "zod";
import {
  BRANDING_ASSET_KINDS,
  BRANDING_ASSET_MAX_BYTES,
  BRANDING_SETTING_KEYS,
  DEFAULT_APP_NAME,
  DEFAULT_SHOW_NAME,
  DEFAULT_THEME,
  appNameSchema,
  brandingAssetKindSchema,
  checkFloor,
  themeSettingsSchema,
  type BrandingAssetKind,
} from "@kobe/protocol";
import { inArray, siteBrandingAssets, siteSettings, type KobeTx } from "@kobe/db";
import { auditRequestContext } from "../audit/context.js";
import { recordAudit } from "../audit/record.js";
import type { AuthVariables } from "../auth/session.js";
import { requireSitePermission } from "../authz/middleware.js";
import {
  BRANDING_KEYS,
  readBrandingSettings,
  storeSetting,
  themeLabel,
} from "../branding/settings.js";
import { inspectImage } from "../branding/sniff.js";
import { brandingCache, deleteAsset, sha256Hex, storeAsset } from "../branding/store.js";
import type { ServerDeps } from "../deps.js";
import { openUpload } from "../uploads/parse.js";

/**
 * Site branding (theming plan §4.2, TH4-TH8, TH12). The two GETs are public (no session, mounted
 * before the auth middleware like /v1/setup; they write nothing); the writes need
 * `site.settings.manage` and pass the API's CSRF origin check. One `site.branding.updated` audit
 * event per changed setting, with a label or the file's sha256, never the bytes.
 */

/** TH8: assets never run anything, even if opened directly. */
const ASSET_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
const IMMUTABLE = "public, max-age=31536000, immutable";
/** Room for the multipart boundaries and part headers around the one file. */
const MULTIPART_OVERHEAD = 16 * 1024;
/** The audit value of a removed file or a reset (a label, TH12). */
const REMOVED = "removed";

/** Whether `If-None-Match` names `etag` (weak or strong, or `*`). */
function ifNoneMatch(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  return header
    .split(",")
    .map((t) => t.trim().replace(/^W\//, ""))
    .some((t) => t === "*" || t === etag);
}

const fail = (
  c: Context,
  status: 400 | 404 | 411 | 413 | 415 | 422,
  code: string,
  message: string,
  extra = {},
) => c.json({ code, message, ...extra }, status);

/** `GET /v1/site/branding` and `GET /v1/site/branding/assets/:kind`: public (TH6). */
export function siteBrandingPublicRoutes(deps: ServerDeps): Hono {
  const app = new Hono();
  const cache = brandingCache(deps.database.db);
  const context = auditRequestContext(deps);

  app.get("/", context, async (c) => {
    const snapshot = await cache.get();
    c.header("ETag", snapshot.etag);
    c.header("Cache-Control", "no-cache");
    if (ifNoneMatch(c.req.header("if-none-match"), snapshot.etag)) return c.body(null, 304);
    c.header("Content-Type", "application/json; charset=utf-8");
    return c.body(snapshot.body, 200);
  });

  app.get("/assets/:kind", context, async (c) => {
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Content-Security-Policy", ASSET_CSP);
    const kind = brandingAssetKindSchema.safeParse(c.req.param("kind"));
    const asset = kind.success ? (await cache.get()).assets.get(kind.data) : undefined;
    if (!asset) return fail(c, 404, "not_found", "No such branding file.");
    const etag = `"${asset.sha256}"`;
    c.header("ETag", etag);
    c.header("Cache-Control", c.req.query("v") === asset.sha256 ? IMMUTABLE : "no-cache");
    if (ifNoneMatch(c.req.header("if-none-match"), etag)) return c.body(null, 304);
    c.header("Content-Type", asset.contentType);
    return c.body(new Uint8Array(asset.bytes), 200);
  });

  return app;
}

const putSchema = z
  .strictObject({
    appName: appNameSchema.optional(),
    showName: z.boolean().optional(),
    theme: themeSettingsSchema.optional(),
  })
  .refine((v) => v.appName !== undefined || v.showName !== undefined || v.theme !== undefined, {
    message: "Change at least one of appName, showName and theme.",
  });

const noFields = z.strictObject({});

type Setting = "app_name" | "show_name" | "theme" | BrandingAssetKind;

async function audited(tx: KobeTx, setting: Setting, value: string): Promise<void> {
  await recordAudit(tx, { action: "site.branding.updated", target: { setting, value } });
}

/** Reads the one file part, at most `max` bytes; null when it is larger. */
async function readCapped(file: Readable, max: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of file) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > max) {
      file.destroy();
      return null;
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

/** The admin routes under `/v1/site/branding` (Owner/Admin: `site.settings.manage`). */
export function siteBrandingRoutes(deps: ServerDeps): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();
  const db = deps.database.db;
  const cache = brandingCache(db);

  app.use(requireSitePermission("site.settings.manage"));

  const current = async (c: Context) => {
    cache.invalidate();
    return c.json(JSON.parse((await cache.get()).body) as unknown);
  };

  app.put("/", async (c) => {
    const parsed = putSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return fail(
        c,
        400,
        "invalid_request",
        parsed.error.issues[0]?.message ?? "Check the fields.",
      );
    }
    const { appName, showName, theme } = parsed.data;
    if (theme?.preset === "custom") {
      const floor = checkFloor(theme);
      if (!floor.ok) {
        const first = floor.failures[0];
        const detail = first ? ` (${first.rule}: ${first.ratio}:1, needs ${first.required}:1)` : "";
        return fail(
          c,
          422,
          "contrast_floor",
          `This accent does not reach the contrast floor${detail}. Choose a darker or more saturated colour.`,
          { failures: floor.failures },
        );
      }
    }
    await db.transaction(async (tx) => {
      const before = await readBrandingSettings(tx);
      const changes: [Setting, string, string, string][] = [];
      if (appName !== undefined && appName !== before.appName) {
        changes.push(["app_name", BRANDING_SETTING_KEYS.appName, appName, appName]);
      }
      if (showName !== undefined && showName !== before.showName) {
        changes.push([
          "show_name",
          BRANDING_SETTING_KEYS.showName,
          String(showName),
          String(showName),
        ]);
      }
      if (theme !== undefined && JSON.stringify(theme) !== JSON.stringify(before.theme)) {
        changes.push([
          "theme",
          BRANDING_SETTING_KEYS.theme,
          JSON.stringify(theme),
          themeLabel(theme),
        ]);
      }
      // Audit last: every write first, then one event per changed setting.
      for (const [, key, value] of changes) await storeSetting(tx, key, value);
      for (const [setting, , , label] of changes) await audited(tx, setting, label);
    });
    return current(c);
  });

  app.put("/assets/:kind", async (c) => {
    const parsedKind = brandingAssetKindSchema.safeParse(c.req.param("kind"));
    if (!parsedKind.success) return fail(c, 404, "not_found", "No such branding file.");
    const kind = parsedKind.data;
    if (!c.req.header("content-type")?.toLowerCase().startsWith("multipart/form-data")) {
      return fail(c, 415, "invalid_request", "Send multipart/form-data with one file.");
    }
    // Refused before a byte of the body is read (§7).
    const maxBytes = BRANDING_ASSET_MAX_BYTES[kind];
    const length = Number(c.req.header("content-length") ?? "NaN");
    if (!Number.isSafeInteger(length) || length < 0) {
      return fail(c, 411, "invalid_request", "Content-Length is required.");
    }
    if (length > maxBytes + MULTIPART_OVERHEAD) {
      return fail(
        c,
        413,
        "file_too_large",
        `Files over ${maxBytes / 1024} KiB are not accepted here.`,
      );
    }
    const body = c.req.raw.body;
    if (!body) return fail(c, 400, "invalid_request", "Malformed upload.");
    const opened = await openUpload(
      c.req.header("content-type"),
      Readable.fromWeb(body as WebReadableStream<Uint8Array>),
      noFields,
    );
    if (!opened.ok) return fail(c, 400, "invalid_request", opened.reason);
    const bytes = await readCapped(opened.upload.file, maxBytes);
    if (bytes === null) {
      return fail(
        c,
        413,
        "file_too_large",
        `Files over ${maxBytes / 1024} KiB are not accepted here.`,
      );
    }
    const finished = await opened.upload.finished.catch(() => null);
    if (finished === null)
      return fail(c, 400, "invalid_request", "The multipart body is malformed.");
    if (finished.extra) return fail(c, 400, "invalid_request", "Send exactly one file.");
    if (bytes.length === 0) return fail(c, 400, "invalid_request", "The file is empty.");
    const image = inspectImage(kind, bytes);
    if (!image.ok) return fail(c, image.status, image.code, image.message);
    const sha256 = sha256Hex(bytes);
    const userId = c.get("user").id;
    await db.transaction(async (tx) => {
      await storeAsset(tx, {
        kind,
        bytes,
        contentType: image.contentType,
        sha256,
        width: image.width,
        height: image.height,
        updatedBy: userId,
      });
      await audited(tx, kind, sha256);
    });
    return current(c);
  });

  app.delete("/assets/:kind", async (c) => {
    const parsedKind = brandingAssetKindSchema.safeParse(c.req.param("kind"));
    if (!parsedKind.success) return fail(c, 404, "not_found", "No such branding file.");
    const kind = parsedKind.data;
    const removed = await db.transaction(async (tx) => {
      if (!(await deleteAsset(tx, kind))) return false;
      await audited(tx, kind, REMOVED);
      return true;
    });
    if (!removed) return fail(c, 404, "not_found", "No such branding file.");
    return current(c);
  });

  /** TH12: the name, the files and the style back to Kobe's, in one transaction. */
  app.post("/reset", async (c) => {
    await db.transaction(async (tx) => {
      const settings = await tx
        .delete(siteSettings)
        .where(inArray(siteSettings.key, [...BRANDING_KEYS]))
        .returning({ key: siteSettings.key });
      const assets = await tx
        .delete(siteBrandingAssets)
        .where(inArray(siteBrandingAssets.kind, [...BRANDING_ASSET_KINDS]))
        .returning({ kind: siteBrandingAssets.kind });
      const removedKeys = new Set(settings.map((r) => r.key));
      const defaults: [Setting, string, string][] = [
        ["app_name", BRANDING_SETTING_KEYS.appName, DEFAULT_APP_NAME],
        ["show_name", BRANDING_SETTING_KEYS.showName, String(DEFAULT_SHOW_NAME)],
        ["theme", BRANDING_SETTING_KEYS.theme, themeLabel(DEFAULT_THEME)],
      ];
      for (const [setting, key, label] of defaults) {
        if (removedKeys.has(key)) await audited(tx, setting, label);
      }
      for (const kind of BRANDING_ASSET_KINDS) {
        if (assets.some((a) => a.kind === kind)) await audited(tx, kind, REMOVED);
      }
    });
    return current(c);
  });

  return app;
}
