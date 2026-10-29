"use client";

import {
  BRANDING_ASSET_CONTENT_TYPES,
  BRANDING_ASSET_MAX_BYTES,
  type BrandingAssetKind,
  type SiteBranding,
} from "@kobe/protocol";
import { useId, useRef, useState, type DragEvent } from "react";
import { removeBrandingAsset, uploadBrandingAsset } from "../../../lib/admin/api/site/branding";
import { Button, Notice } from "../../ui/console";
import { MutationStatus } from "../error-notice";
import { useMutation } from "../use-resource";

/**
 * One branding file (KOBE-501, TH7/TH8): pick or drop it, see the current one, remove it. A file
 * applies as soon as it is uploaded (the name and style wait for Save). The server checks the
 * bytes (type, size, pixels, SVG content); its refusal is shown as it says it.
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

const kib = (bytes: number): number => Math.ceil(bytes / 1024);

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

function Current({
  kind,
  branding,
}: {
  readonly kind: BrandingAssetKind;
  readonly branding: SiteBranding;
}) {
  const url = currentUrl(kind, branding);
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

export function AssetField({
  kind,
  branding,
  onChanged,
}: {
  readonly kind: BrandingAssetKind;
  readonly branding: SiteBranding;
  readonly onChanged: (next: SiteBranding) => void;
}) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const mutation = useMutation();
  const [tooLarge, setTooLarge] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const label = LABEL[kind];
  const max = BRANDING_ASSET_MAX_BYTES[kind];
  const current = currentUrl(kind, branding);

  async function upload(file: File | undefined) {
    if (file === undefined) return;
    mutation.clear();
    if (file.size > max) {
      setTooLarge(`${file.name} is ${kib(file.size)} KiB; the limit here is ${kib(max)} KiB.`);
      return;
    }
    setTooLarge(null);
    const done = await mutation.run(
      async () => {
        const res = await uploadBrandingAsset(kind, file);
        if (res.ok) onChanged(res.data);
        return res;
      },
      () => `${label} saved. Every page shows it from its next load.`,
    );
    if (!done && input.current) input.current.value = "";
  }

  async function remove() {
    setTooLarge(null);
    await mutation.run(
      async () => {
        const res = await removeBrandingAsset(kind);
        if (res.ok) onChanged(res.data);
        return res;
      },
      () => `${label} removed.`,
    );
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
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
        {HINT[kind]} {formats(kind)}, up to {kib(max)} KiB.
      </p>
      <Current kind={kind} branding={branding} />
      <div
        data-kobe-drop={kind}
        {...(dragging ? { "data-dragging": "" } : {})}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className="box-border flex flex-wrap items-center gap-2 rounded-md border border-dashed border-console-control p-3 data-dragging:bg-console-panel"
      >
        <input
          ref={input}
          type="file"
          hidden
          aria-label={`${label} file`}
          accept={acceptOf(kind)}
          onChange={(e) => void upload(e.target.files?.[0])}
        />
        <Button
          loading={mutation.pending}
          onClick={() => input.current?.click()}
        >{`Choose a ${label.toLowerCase()}…`}</Button>
        <span className="text-sm text-console-muted">or drop a file here.</span>
        {current !== null && (
          <Button
            variant="danger"
            disabled={mutation.pending}
            aria-label={`Remove the ${label.toLowerCase()}`}
            onClick={() => void remove()}
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
