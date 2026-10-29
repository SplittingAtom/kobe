import { createHash } from "node:crypto";
import { BRANDING_ASSET_KINDS, type BrandingAssetKind, type SiteBranding } from "@kobe/protocol";
import { eq, siteBrandingAssets, type KobeDb, type KobeTx } from "@kobe/db";
import { readBrandingSettings, type BrandingSettings } from "./settings.js";

/**
 * Branding storage and the public snapshot (TH6, TH7): the settings and the files, read together
 * and read from the database on every request (no per-replica cache; see BrandingCache).
 */

export interface StoredAsset {
  readonly kind: BrandingAssetKind;
  readonly bytes: Buffer;
  readonly contentType: string;
  readonly sha256: string;
  readonly width: number | null;
  readonly height: number | null;
}

export interface BrandingSnapshot {
  readonly settings: BrandingSettings;
  readonly assets: ReadonlyMap<BrandingAssetKind, StoredAsset>;
  /** `GET /v1/site/branding`'s body and its strong ETag. */
  readonly body: string;
  readonly etag: string;
}

export const sha256Hex = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");

export const assetUrl = (kind: BrandingAssetKind, sha256: string): string =>
  `/v1/site/branding/assets/${kind}?v=${sha256}`;

export function publicBranding(
  settings: BrandingSettings,
  assets: ReadonlyMap<BrandingAssetKind, StoredAsset>,
): SiteBranding {
  const url = (kind: BrandingAssetKind) => {
    const asset = assets.get(kind);
    return asset ? assetUrl(kind, asset.sha256) : undefined;
  };
  /** The known pixel box of `kind` under the given field names (both sides or neither). */
  const size = (kind: BrandingAssetKind, w: string, h: string) => {
    const asset = assets.get(kind);
    return asset?.width && asset.height ? { [w]: asset.width, [h]: asset.height } : {};
  };
  const light = url("logo");
  const dark = url("logo_dark");
  const favicon = url("favicon");
  return {
    appName: settings.appName,
    showName: settings.showName,
    // A dark logo alone is not shown: it is the light logo's variant.
    logo:
      light === undefined
        ? null
        : {
            url: light,
            ...size("logo", "width", "height"),
            ...(dark ? { dark, ...size("logo_dark", "darkWidth", "darkHeight") } : {}),
          },
    favicon: favicon ?? null,
    theme: settings.theme,
  };
}

async function loadSnapshot(db: KobeDb): Promise<BrandingSnapshot> {
  const [settings, rows] = await Promise.all([
    readBrandingSettings(db),
    db
      .select({
        kind: siteBrandingAssets.kind,
        bytes: siteBrandingAssets.bytes,
        contentType: siteBrandingAssets.contentType,
        sha256: siteBrandingAssets.sha256,
        width: siteBrandingAssets.width,
        height: siteBrandingAssets.height,
      })
      .from(siteBrandingAssets),
  ]);
  const assets = new Map<BrandingAssetKind, StoredAsset>();
  for (const row of rows) {
    const kind = BRANDING_ASSET_KINDS.find((k) => k === row.kind);
    if (kind) assets.set(kind, { ...row, kind });
  }
  const body = JSON.stringify(publicBranding(settings, assets));
  return { settings, assets, body, etag: `"${sha256Hex(body).slice(0, 32)}"` };
}

/**
 * The snapshot loader. It keeps no time-based cache: the server runs several replicas, and a write
 * on one replica must show on the very next read on every replica (the web's 30 s cache and its
 * refresh route, KOBE-501, rely on `GET /v1/site/branding` being current right after a save; with
 * a per-replica TTL the admin's reload showed the old values). Concurrent reads share one load; the
 * rows are few and small, and browsers hold the assets by hash (`?v=`), so this costs little.
 */
export class BrandingCache {
  private inflight: Promise<BrandingSnapshot> | undefined;

  constructor(private readonly db: KobeDb) {}

  get(): Promise<BrandingSnapshot> {
    if (this.inflight) return this.inflight;
    const snapshot = loadSnapshot(this.db);
    this.inflight = snapshot;
    const done = () => {
      if (this.inflight === snapshot) this.inflight = undefined;
    };
    snapshot.then(done, done);
    return snapshot;
  }

  /** Drops a load in flight so the next read starts fresh (after this replica's own writes). */
  invalidate(): void {
    this.inflight = undefined;
  }
}

const caches = new WeakMap<KobeDb, BrandingCache>();

/** The replica's loader for this database (shared by the public and the admin routes). */
export function brandingCache(db: KobeDb): BrandingCache {
  let cache = caches.get(db);
  if (!cache) {
    cache = new BrandingCache(db);
    caches.set(db, cache);
  }
  return cache;
}

export interface NewAsset {
  readonly kind: BrandingAssetKind;
  readonly bytes: Buffer;
  readonly contentType: string;
  readonly sha256: string;
  readonly width: number | null;
  readonly height: number | null;
  readonly updatedBy: string;
}

/** Inserts or replaces the file of `asset.kind`. */
export async function storeAsset(tx: KobeTx, asset: NewAsset): Promise<void> {
  const values = {
    bytes: asset.bytes,
    contentType: asset.contentType,
    sha256: asset.sha256,
    byteSize: asset.bytes.length,
    width: asset.width,
    height: asset.height,
    updatedBy: asset.updatedBy,
    updatedAt: new Date(),
  };
  await tx
    .insert(siteBrandingAssets)
    .values({ kind: asset.kind, ...values })
    .onConflictDoUpdate({ target: siteBrandingAssets.kind, set: values });
}

/** Removes the file of `kind`; false when there was none. */
export async function deleteAsset(tx: KobeTx, kind: BrandingAssetKind): Promise<boolean> {
  const removed = await tx
    .delete(siteBrandingAssets)
    .where(eq(siteBrandingAssets.kind, kind))
    .returning({ kind: siteBrandingAssets.kind });
  return removed.length > 0;
}
