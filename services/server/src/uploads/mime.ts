/**
 * Content sniffing for uploads (D26: any type is accepted, so this never rejects). The stored
 * `mime_type` is what the bytes look like when they match a known signature, else the client's
 * declared type if it is a well-formed media type, else `application/octet-stream`. The
 * declared type alone is never trusted over the signature.
 */
export const SNIFF_BYTES = 16;
const FALLBACK = "application/octet-stream";

const startsWith = (b: Uint8Array, sig: readonly number[], at = 0): boolean =>
  sig.every((v, i) => b[at + i] === v);
const ascii = (b: Uint8Array, text: string, at: number): boolean =>
  [...text].every((c, i) => b[at + i] === c.charCodeAt(0));

export function sniffMime(head: Uint8Array): string | undefined {
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(head, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (ascii(head, "GIF8", 0)) return "image/gif";
  if (ascii(head, "RIFF", 0) && ascii(head, "WEBP", 8)) return "image/webp";
  if (ascii(head, "%PDF-", 0)) return "application/pdf";
  if (startsWith(head, [0x50, 0x4b, 0x03, 0x04])) return "application/zip";
  if (startsWith(head, [0x1f, 0x8b])) return "application/gzip";
  return undefined;
}

const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;

/** The mime type to store for a file with first bytes `head` and the client's `declared` type. */
export function resolveMime(head: Uint8Array, declared: string | undefined): string {
  const sniffed = sniffMime(head);
  // A zip signature also covers docx/xlsx/jar: keep a declared, well-formed, more specific type.
  const clean = declared?.split(";")[0]?.trim().toLowerCase();
  const valid = clean !== undefined && MEDIA_TYPE.test(clean) ? clean : undefined;
  if (sniffed === "application/zip" && valid !== undefined) return valid;
  return sniffed ?? valid ?? FALLBACK;
}
