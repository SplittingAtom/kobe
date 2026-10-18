import { z } from "zod";
import { changelogSchema, semverSchema } from "./semver.js";

/**
 * The body of a skill upload (KOBE-78, KOBE-308). Either the bundle itself (a zip, or a bare
 * SKILL.md as text/markdown) with an optional `?semver=`, or `multipart/form-data` with the
 * bundle in a `bundle` file part and optional `semver` and `changelog` fields. The changelog is
 * free text, so it travels only in the body: never in the URL, where access logs keep it.
 */
export const ZIP_TYPES: ReadonlySet<string> = new Set([
  "application/zip",
  "application/x-zip-compressed",
  "application/octet-stream",
]);
export const MARKDOWN_TYPES: ReadonlySet<string> = new Set([
  "text/markdown",
  "text/x-markdown",
  "text/plain",
]);

export type UploadKind = "zip" | "markdown";

export interface UploadBody {
  readonly kind: UploadKind;
  readonly bytes: Uint8Array;
  readonly semver?: string | undefined;
  readonly changelog?: string | undefined;
}

export type UploadBodyResult =
  | { readonly ok: true; readonly body: UploadBody }
  | {
      readonly ok: false;
      readonly status: 400 | 415;
      readonly code: string;
      readonly message: string;
    };

const numberingSchema = z.strictObject({
  semver: semverSchema.optional(),
  changelog: changelogSchema.optional(),
});

const INVALID_NUMBERING = {
  ok: false,
  status: 400,
  code: "invalid_request",
  message:
    "Give semver as MAJOR.MINOR.PATCH (for example 1.2.0) and a changelog of 1 to 1024 characters.",
} as const;
const UNSUPPORTED = {
  ok: false,
  status: 415,
  code: "unsupported_media_type",
  message: "Send application/zip, text/markdown, or multipart/form-data with a bundle file.",
} as const;

const mediaType = (value: string | null | undefined): string =>
  (value ?? "").split(";")[0]?.trim().toLowerCase() ?? "";

function kindOf(type: string, name = ""): UploadKind | null {
  if (ZIP_TYPES.has(type)) return "zip";
  if (MARKDOWN_TYPES.has(type)) return "markdown";
  if (type === "" && /\.zip$/i.test(name)) return "zip";
  if (type === "" && /\.md$/i.test(name)) return "markdown";
  return null;
}

/** A form field as text: absent and empty both mean "not given"; a file part is invalid. */
function field(form: FormData, name: string): string | undefined | null {
  const value = form.get(name);
  if (value === null || value === "") return undefined;
  return typeof value === "string" ? value : null;
}

/** Reads and checks an upload request: the bundle bytes, their kind and the numbering. */
export async function readUploadBody(
  req: Request,
  query: URLSearchParams,
): Promise<UploadBodyResult> {
  // Free text in the URL would land in access logs: refuse it rather than accept it there.
  if (query.has("changelog"))
    return { ...INVALID_NUMBERING, message: "Send the changelog as a multipart form field." };
  const querySemver = query.get("semver") ?? undefined;
  const type = mediaType(req.headers.get("content-type"));
  if (type !== "multipart/form-data") {
    const kind = kindOf(type);
    if (!kind) return UNSUPPORTED;
    const numbering = numberingSchema.safeParse({ semver: querySemver });
    if (!numbering.success) return INVALID_NUMBERING;
    const bytes = new Uint8Array(await req.arrayBuffer());
    return { ok: true, body: { kind, bytes, ...numbering.data } };
  }
  const form = await req.formData().catch(() => null);
  const bundle = form?.get("bundle");
  if (!form || !(bundle instanceof File)) return UNSUPPORTED;
  const kind = kindOf(mediaType(bundle.type), bundle.name);
  if (!kind) return UNSUPPORTED;
  const semver = field(form, "semver");
  const changelog = field(form, "changelog");
  if (semver === null || changelog === null) return INVALID_NUMBERING;
  if (semver !== undefined && querySemver !== undefined && semver !== querySemver)
    return { ...INVALID_NUMBERING, message: "Give semver once: in the form or in the query." };
  const numbering = numberingSchema.safeParse({
    semver: semver ?? querySemver,
    changelog,
  });
  if (!numbering.success) return INVALID_NUMBERING;
  const bytes = new Uint8Array(await bundle.arrayBuffer());
  return { ok: true, body: { kind, bytes, ...numbering.data } };
}
