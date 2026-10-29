/**
 * Site console: Appearance (KOBE-501, theming plan §6), over the branding API (KOBE-499):
 * `GET /v1/site/branding` (public), and for Owner/Admin (`site.settings.manage`) `PUT` of the
 * name, the name switch and the style, one file per kind, removal and reset. Every change is
 * audited by the server (`site.branding.updated`).
 */
import type {
  BrandingAssetKind,
  FloorFailure,
  SiteBranding,
  ThemeSettings,
} from "@kobe/protocol";
import { apiRequest, type ApiError, type ApiResult } from "../../../api/client";

export interface BrandingChange {
  readonly appName?: string;
  readonly showName?: boolean;
  readonly theme?: ThemeSettings;
}

/** A save's answer; a refused accent (422 `contrast_floor`) carries the server's failures. */
export type BrandingSaveResult =
  | { readonly ok: true; readonly status: number; readonly data: SiteBranding }
  | {
      readonly ok: false;
      readonly error: ApiError;
      readonly failures: readonly FloorFailure[];
    };

const BASE = "/v1/site/branding";

export function getBranding(): Promise<ApiResult<SiteBranding>> {
  return apiRequest(BASE);
}

const SCHEMES: ReadonlySet<unknown> = new Set(["light", "dark", "both"]);

function isFailure(v: unknown): v is FloorFailure {
  if (v === null || typeof v !== "object") return false;
  const f = v as Record<string, unknown>;
  return (
    typeof f["rule"] === "string" &&
    SCHEMES.has(f["scheme"]) &&
    typeof f["ratio"] === "number" &&
    typeof f["required"] === "number"
  );
}

/** The `failures` of a 422 body, when every entry is well formed (else none). */
function failuresOf(body: unknown): readonly FloorFailure[] {
  if (body === null || typeof body !== "object") return [];
  const list = (body as { failures?: unknown }).failures;
  return Array.isArray(list) && list.every(isFailure) ? list : [];
}

/** Sends only the settings given (at least one); a custom accent under the floor gets a 422. */
export async function putBranding(change: BrandingChange): Promise<BrandingSaveResult> {
  let failures: readonly FloorFailure[] = [];
  // apiRequest keeps only code and message: read the 422's failures from a copy of the answer.
  const capture: typeof fetch = async (input, init) => {
    const res = await fetch(input, init);
    if (res.status === 422) failures = failuresOf(await res.clone().json().catch(() => null));
    return res;
  };
  const res = await apiRequest<SiteBranding>(BASE, {
    method: "PUT",
    json: { ...change },
    fetchFn: capture,
  });
  return res.ok ? res : { ok: false, error: res.error, failures };
}

/** Replaces one file (logo, dark logo, favicon); the server checks type, size and SVG content. */
export function uploadBrandingAsset(
  kind: BrandingAssetKind,
  file: File,
): Promise<ApiResult<SiteBranding>> {
  const form = new FormData();
  form.append("file", file, file.name);
  return apiRequest(`${BASE}/assets/${kind}`, { method: "PUT", form });
}

export function removeBrandingAsset(kind: BrandingAssetKind): Promise<ApiResult<SiteBranding>> {
  return apiRequest(`${BASE}/assets/${kind}`, { method: "DELETE" });
}

/** The name, the files and the style back to Kobe's, in one step (TH12). */
export function resetBranding(): Promise<ApiResult<SiteBranding>> {
  return apiRequest(`${BASE}/reset`, { method: "POST" });
}
