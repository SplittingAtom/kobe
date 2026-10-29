import {
  BRANDING_ASSET_CONTENT_TYPES,
  BRANDING_ASSET_MAX_SIDE_PX,
  type BrandingAssetContentType,
  type BrandingAssetKind,
} from "@kobe/protocol";
import { checkSvg } from "./svg.js";

/**
 * Branding upload checks (TH8): the type comes from the bytes (magic numbers; SVG parsed as XML),
 * never from the upload's declared type; raster dimensions are parsed and capped (§7).
 */

export type DetectedType =
  "image/png" | "image/jpeg" | "image/webp" | "image/x-icon" | "image/svg+xml";

export interface AcceptedImage {
  readonly ok: true;
  readonly contentType: BrandingAssetContentType;
  /** Null for ICO and for an SVG without width/height or viewBox. */
  readonly width: number | null;
  readonly height: number | null;
}

export interface RefusedImage {
  readonly ok: false;
  readonly status: 415 | 422;
  readonly code: "unsupported_type" | "invalid_image" | "image_too_large" | "svg_refused";
  readonly message: string;
}

const startsWith = (bytes: Uint8Array, prefix: readonly number[], at = 0): boolean =>
  bytes.length >= at + prefix.length && prefix.every((b, i) => bytes[at + i] === b);
const ascii = (s: string): number[] => [...s].map((ch) => ch.charCodeAt(0));

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_SOI = [0xff, 0xd8, 0xff];
const ICO_HEADER = [0x00, 0x00, 0x01, 0x00];

/** The type the bytes say they are, or null (SVG: looks like XML; checked fully later). */
export function detectType(bytes: Uint8Array): DetectedType | null {
  if (startsWith(bytes, PNG_SIGNATURE)) return "image/png";
  if (startsWith(bytes, JPEG_SOI)) return "image/jpeg";
  if (startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8)) return "image/webp";
  if (startsWith(bytes, ICO_HEADER)) return "image/x-icon";
  if (looksLikeXml(bytes)) return "image/svg+xml";
  return null;
}

function looksLikeXml(bytes: Uint8Array): boolean {
  let i = startsWith(bytes, [0xef, 0xbb, 0xbf]) ? 3 : 0;
  while (i < bytes.length && [0x20, 0x09, 0x0a, 0x0d].includes(bytes[i] ?? 0)) i += 1;
  return bytes[i] === 0x3c; // "<"
}

interface Size {
  readonly width: number;
  readonly height: number;
}

const view = (bytes: Uint8Array): DataView =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

function pngSize(bytes: Uint8Array): Size | null {
  // Signature, then the IHDR chunk: length (13), "IHDR", width, height (big-endian).
  if (bytes.length < 24 || !startsWith(bytes, ascii("IHDR"), 12)) return null;
  const v = view(bytes);
  return { width: v.getUint32(16), height: v.getUint32(20) };
}

const isSof = (marker: number): boolean =>
  marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);

function jpegSize(bytes: Uint8Array): Size | null {
  const v = view(bytes);
  let i = 2;
  while (i + 4 <= bytes.length) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1] ?? 0;
    if (marker === 0xff) {
      i += 1; // fill byte
      continue;
    }
    // Standalone markers (TEM, RSTn) carry no length.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // EOI / SOS before any frame header
    const length = v.getUint16(i + 2);
    if (length < 2) return null;
    if (isSof(marker)) {
      if (i + 9 > bytes.length) return null;
      return { height: v.getUint16(i + 5), width: v.getUint16(i + 7) };
    }
    i += 2 + length;
  }
  return null;
}

function webpSize(bytes: Uint8Array): Size | null {
  if (bytes.length < 25) return null;
  const v = view(bytes);
  if (startsWith(bytes, ascii("VP8L"), 12)) {
    if (bytes[20] !== 0x2f) return null;
    const bits = v.getUint32(21, true);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (bytes.length < 30) return null;
  if (startsWith(bytes, ascii("VP8X"), 12)) {
    const w = (bytes[24] ?? 0) | ((bytes[25] ?? 0) << 8) | ((bytes[26] ?? 0) << 16);
    const h = (bytes[27] ?? 0) | ((bytes[28] ?? 0) << 8) | ((bytes[29] ?? 0) << 16);
    return { width: w + 1, height: h + 1 };
  }
  if (startsWith(bytes, ascii("VP8 "), 12)) {
    // Frame tag (3 bytes), start code 9d 01 2a, then 14-bit width and height (little-endian).
    if (!startsWith(bytes, [0x9d, 0x01, 0x2a], 23)) return null;
    return { width: v.getUint16(26, true) & 0x3fff, height: v.getUint16(28, true) & 0x3fff };
  }
  return null;
}

const ICO_ENTRY_BYTES = 16;
const BITMAPINFOHEADER_BYTES = 40;

/** One embedded image: a PNG (IHDR) or a BMP without file header (BITMAPINFOHEADER). */
function icoImageSize(image: Uint8Array): Size | null {
  if (startsWith(image, PNG_SIGNATURE)) return pngSize(image);
  if (image.length < BITMAPINFOHEADER_BYTES) return null;
  const v = view(image);
  if (v.getUint32(0, true) < BITMAPINFOHEADER_BYTES) return null;
  // The height counts the XOR and the AND mask: half of it is the image.
  const width = Math.abs(v.getInt32(4, true));
  const height = Math.abs(v.getInt32(8, true)) / 2;
  return Number.isInteger(height) ? { width, height } : null;
}

/**
 * The ICONDIR: every entry's image lies after the directory and within the file, and parses;
 * returns the largest image's size (for the side cap), or null when anything is malformed.
 */
function icoSize(bytes: Uint8Array): Size | null {
  if (bytes.length < 6) return null;
  const v = view(bytes);
  const count = v.getUint16(4, true);
  const directoryEnd = 6 + ICO_ENTRY_BYTES * count;
  if (count === 0 || bytes.length < directoryEnd) return null;
  let largest: Size = { width: 0, height: 0 };
  for (let i = 0; i < count; i += 1) {
    const entry = 6 + ICO_ENTRY_BYTES * i;
    const size = v.getUint32(entry + 8, true);
    const offset = v.getUint32(entry + 12, true);
    if (size === 0 || offset < directoryEnd || offset + size > bytes.length) return null;
    const image = icoImageSize(bytes.subarray(offset, offset + size));
    if (image === null || image.width < 1 || image.height < 1) return null;
    if (Math.max(image.width, image.height) > Math.max(largest.width, largest.height)) {
      largest = image;
    }
  }
  return largest;
}

const NAMES: Readonly<Record<DetectedType, string>> = {
  "image/png": "PNG",
  "image/jpeg": "JPEG",
  "image/webp": "WebP",
  "image/x-icon": "ICO",
  "image/svg+xml": "SVG",
};

const refuse = (
  status: RefusedImage["status"],
  code: RefusedImage["code"],
  message: string,
): RefusedImage => ({ ok: false, status, code, message });

function allowedNames(kind: BrandingAssetKind): string {
  return BRANDING_ASSET_CONTENT_TYPES[kind].map((t) => NAMES[t]).join(", ");
}

function rasterSize(type: DetectedType, bytes: Uint8Array): Size | null {
  if (type === "image/png") return pngSize(bytes);
  if (type === "image/jpeg") return jpegSize(bytes);
  return webpSize(bytes);
}

/** Accepts or refuses an upload of `kind`, with the rule named on refusal. */
export function inspectImage(
  kind: BrandingAssetKind,
  bytes: Uint8Array,
): AcceptedImage | RefusedImage {
  const type = detectType(bytes);
  const allowed: readonly string[] = BRANDING_ASSET_CONTENT_TYPES[kind];
  if (type === null || !allowed.includes(type)) {
    return refuse(
      415,
      "unsupported_type",
      `${type === null ? "This file type is not accepted" : `${NAMES[type]} is not accepted here`}: use ${allowedNames(kind)}.`,
    );
  }
  const contentType = type as BrandingAssetContentType;
  if (type === "image/svg+xml") {
    const svg = checkSvg(bytes, BRANDING_ASSET_MAX_SIDE_PX);
    if (!svg.ok) return refuse(422, "svg_refused", `This SVG is refused: ${svg.reason}`);
    // The box from width/height or the viewBox (aspect only), so pages can reserve the space.
    return {
      ok: true,
      contentType,
      width: svg.size?.width ?? null,
      height: svg.size?.height ?? null,
    };
  }
  const size = type === "image/x-icon" ? icoSize(bytes) : rasterSize(type, bytes);
  if (size === null || size.width < 1 || size.height < 1) {
    return refuse(422, "invalid_image", `The ${NAMES[type]} file is damaged: no image size found.`);
  }
  if (size.width > BRANDING_ASSET_MAX_SIDE_PX || size.height > BRANDING_ASSET_MAX_SIDE_PX) {
    return refuse(
      422,
      "image_too_large",
      `Images may be at most ${BRANDING_ASSET_MAX_SIDE_PX} px on each side; this one is ${size.width}×${size.height}.`,
    );
  }
  // An ICO holds several sizes; the browser picks one, so none is recorded.
  if (type === "image/x-icon") return { ok: true, contentType, width: null, height: null };
  return { ok: true, contentType, width: size.width, height: size.height };
}
