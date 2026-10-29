"use client";

import {
  BRANDING_ASSET_CONTENT_TYPES,
  BRANDING_ASSET_MAX_BYTES,
  type BrandingAssetKind,
  type SiteBranding,
} from "@kobe/protocol";
import { useEffect, useId, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import {
  DARK_LOGO_URL,
  hasDarkLogoAlone,
  removeBrandingAsset,
  uploadBrandingAsset,
} from "../../../lib/admin/api/site/branding";
import { formatKiB } from "../../../lib/files/format";
import { Button, Notice } from "../../ui/console";
import type { ApiResult } from "../../../lib/api/client";
import { MutationStatus } from "../error-notice";
import { useMutation } from "../use-resource";

/**
 * One branding file (KOBE-501, TH7/TH8): pick or drop it, see the current one, remove it. A file
 * applies as soon as it is uploaded (the name and style wait for Save); the page then reloads.
 * The server checks the bytes (type, size, pixels, SVG content); its refusal is shown as it says
 * it. The dark logo needs a logo (the public branding names it only next to one): its field is
 * off without a logo, but a dark logo stored anyway is still shown with Remove.
 */

const LABEL: Readonly<Record<BrandingAssetKind, string>> = {
  logo: "Logo",
  logo_dark: "Dark logo",
  favicon: "Favicon",
};

const HINT: Readonly<Record<BrandingAssetKind, string>> = {
  logo: "Shown 24 px tall (at most 160 px wide) in the header and at sign-in.",
  logo_dark: "Optional: used instead of the logo in the dark theme. Shown once there is a logo.",
  favicon: "The icon in browser tabs and bookmarks. One file; the browser scales it.",
};

const FORMAT: Readonly<Record<string, string>> = {
  "image/png": "PNG",
  "image/jpeg": "JPEG",
  "image/webp": "WebP",
  "image/svg+xml": "SVG",
  "image/x-icon": "ICO",
};

const EXTENSIONS: Readonly<Record<string, readonly string[]>> = {
  "image/png": [".png"],
  "image/jpeg": [".jpg", ".jpeg"],
  "image/webp": [".webp"],
  "image/svg+xml": [".svg"],
  "image/x-icon": [".ico"],
};

const SVG_HINT = "Export the file as Plain SVG (Inkscape's own format is refused).";

function formats(kind: BrandingAssetKind): string {
  const names = BRANDING_ASSET_CONTENT_TYPES[kind].map((t) => FORMAT[t] ?? t);
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} or ${names.at(-1)}` : names.join("");
}

function acceptOf(kind: BrandingAssetKind): string {
  const types: readonly string[] = BRANDING_ASSET_CONTENT_TYPES[kind];
  return [...types, ...types.flatMap((t) => EXTENSIONS[t] ?? [])].join(",");
}

/** The file currently served for `kind`, as the public branding names it. */
function currentUrl(kind: BrandingAssetKind, b: SiteBranding): string | null {
  if (kind === "favicon") return b.favicon;
  if (kind === "logo") return b.logo?.url ?? null;
  return b.logo?.dark ?? null;
}

/** A dark logo stored while there is no logo, which the public branding does not name. */
function useDarkLogoAlone(kind: BrandingAssetKind, branding: SiteBranding): string | null {
  const probe = kind === "logo_dark" && branding.logo === null;
  const [found, setFound] = useState(false);
  useEffect(() => {
    if (!probe) return;
    let live = true;
    void hasDarkLogoAlone().then((yes) => {
      if (live) setFound(yes);
    });
    return () => {
      live = false;
    };
  }, [probe, branding]);
  return probe && found ? DARK_LOGO_URL : null;
}

function Current({ kind, url }: { readonly kind: BrandingAssetKind; readonly url: string | null }) {
  if (url === null) return <p className="m-0 text-sm text-console-muted">None yet.</p>;
  if (kind === "favicon") {
    return (
      <div className="flex items-end gap-3">
        <img src={url} alt="Favicon at 16 px" width={16} height={16} />
        <img src={url} alt="Favicon at 32 px" width={32} height={32} />
      </div>
    );
  }
  // The logo on a light and a dark background (the dark logo only where it is used): the swatches
  // take each scheme's default tokens from the preview's stylesheet (lib/theme/preview-css.ts).
  const swatch =
    "flex h-10 min-w-24 items-center justify-center rounded-md border border-console-border bg-console-bg px-3";
  const img = (alt: string) => (
    <img src={url} alt={alt} className="block h-6 w-auto max-w-40 object-contain" />
  );
  return (
    <div className="flex flex-wrap gap-2">
      {kind === "logo" && (
        <div data-kobe-swatch="light" className={swatch}>
          {img("Logo on a light background")}
        </div>
      )}
      <div data-kobe-swatch="dark" className={swatch}>
        {img(`${LABEL[kind]} on a dark background`)}
      </div>
    </div>
  );
}

const hasFiles = (e: DragEvent) => e.dataTransfer.types.includes("Files");

export function AssetField({
  kind,
  branding,
  onApplied,
}: {
  readonly kind: BrandingAssetKind;
  readonly branding: SiteBranding;
  /** After a successful upload or removal, with the new branding (the page reloads). */
  readonly onApplied: (next: SiteBranding) => void | Promise<void>;
}) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const mutation = useMutation();
  const [tooLarge, setTooLarge] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const label = LABEL[kind];
  const max = BRANDING_ASSET_MAX_BYTES[kind];
  const alone = useDarkLogoAlone(kind, branding);
  const current = currentUrl(kind, branding) ?? alone;
  const needsLogo = kind === "logo_dark" && branding.logo === null;

  async function apply(change: () => Promise<ApiResult<SiteBranding>>, notice: string) {
    const result: { next?: SiteBranding } = {};
    const done = await mutation.run(
      async () => {
        const res = await change();
        if (res.ok) result.next = res.data;
        return res;
      },
      () => notice,
    );
    if (done && result.next !== undefined) await onApplied(result.next);
  }

  async function upload(file: File | undefined) {
    if (file === undefined || needsLogo) return;
    mutation.clear();
    if (file.size > max) {
      setTooLarge(`${file.name} is ${formatKiB(file.size)}; the limit here is ${formatKiB(max)}.`);
      return;
    }
    setTooLarge(null);
    await apply(() => uploadBrandingAsset(kind, file), `${label} saved. Reloading…`);
  }

  function onPick(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // the same file can be picked again, whatever happened to this one
    void upload(file);
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    setDragging(false);
    void upload(e.dataTransfer.files[0]);
  }

  return (
    <div role="group" aria-labelledby={`${id}-label`} className="mt-4 flex flex-col gap-2">
      <span id={`${id}-label`} className="font-medium">
        {label}
      </span>
      <p className="m-0 text-sm text-console-muted">
        {HINT[kind]} {formats(kind)}, up to {formatKiB(max)}.
      </p>
      <Current kind={kind} url={current} />
      <div
        data-kobe-drop={kind}
        {...(dragging ? { "data-dragging": "" } : {})}
        onDragOver={(e) => {
          if (needsLogo || !hasFiles(e)) return;
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={(e) => {
          if (e.currentTarget.contains(e.relatedTarget as Node | null)) return; // into a child
          setDragging(false);
        }}
        onDrop={onDrop}
        className="box-border flex flex-wrap items-center gap-2 rounded-md border border-dashed border-console-control p-3 data-dragging:bg-console-panel"
      >
        <input
          ref={input}
          type="file"
          hidden
          aria-label={`${label} file`}
          accept={acceptOf(kind)}
          disabled={needsLogo}
          onChange={onPick}
        />
        <Button
          loading={mutation.pending}
          disabled={needsLogo}
          {...(needsLogo ? { "aria-describedby": `${id}-needs-logo` } : {})}
          onClick={() => input.current?.click()}
        >{`Choose a ${label.toLowerCase()}…`}</Button>
        {needsLogo ? (
          <span id={`${id}-needs-logo`} className="text-sm text-console-muted">
            Upload a logo first.
          </span>
        ) : (
          <span className="text-sm text-console-muted">or drop a file here.</span>
        )}
        {current !== null && (
          <Button
            variant="danger"
            disabled={mutation.pending}
            aria-label={`Remove the ${label.toLowerCase()}`}
            onClick={() =>
              void apply(() => removeBrandingAsset(kind), `${label} removed. Reloading…`)
            }
          >
            Remove
          </Button>
        )}
      </div>
      {tooLarge && <Notice tone="error">{tooLarge}</Notice>}
      <MutationStatus error={mutation.error} notice={mutation.notice} />
      {mutation.error?.code === "svg_refused" && (
        <p className="m-0 text-sm text-console-muted">{SVG_HINT}</p>
      )}
    </div>
  );
}
