import type { Readable } from "node:stream";
import busboy from "busboy";
import { uploadFieldsSchema, uploadFileNameSchema } from "@kobe/protocol";

/**
 * Streaming parse of `POST /v1/uploads` (multipart/form-data): optional text field `thread_id`
 * first, then exactly one file part. Resolves at the file's first byte with its stream, so the
 * caller pipes it to S3 without ever holding the file; `finished` settles when the whole body
 * has been read.
 */
export interface OpenedUpload {
  readonly threadId: string | undefined;
  readonly name: string;
  readonly declaredMime: string;
  readonly file: Readable;
  /** Resolves once the body is fully read; `extra` is true when more than one file was sent. */
  readonly finished: Promise<{ readonly extra: boolean }>;
}

export type OpenResult =
  | { readonly ok: true; readonly upload: OpenedUpload }
  | { readonly ok: false; readonly reason: string };

const MAX_FIELD_BYTES = 256;

export function openUpload(contentType: string | undefined, body: Readable): Promise<OpenResult> {
  let parser: busboy.Busboy;
  try {
    parser = busboy({
      headers: { "content-type": contentType ?? "" },
      limits: { files: 1, fields: 4, parts: 6, fieldSize: MAX_FIELD_BYTES },
      preservePath: false,
      defParamCharset: "utf8",
    });
  } catch {
    return Promise.resolve({ ok: false, reason: "The request must be multipart/form-data." });
  }
  return new Promise<OpenResult>((resolve) => {
    const fields: Record<string, string> = {};
    let badField = false;
    let opened = false;
    let extra = false;
    let settle: (r: { extra: boolean }) => void = () => undefined;
    let fail: (err: unknown) => void = () => undefined;
    const finished = new Promise<{ extra: boolean }>((res, rej) => {
      settle = res;
      fail = rej;
    });
    // Unobserved rejections must not crash the process if the caller already gave up.
    finished.catch(() => undefined);
    let current: Readable | undefined;

    parser.on("field", (name, value, info) => {
      if (opened || info.nameTruncated || info.valueTruncated || name in fields) badField = true;
      else fields[name] = value;
    });
    parser.on("file", (_name, file, info) => {
      if (opened) {
        extra = true;
        file.resume();
        return;
      }
      const reject = (reason: string) => {
        file.resume();
        resolve({ ok: false, reason });
      };
      opened = true;
      const parsedFields = uploadFieldsSchema.safeParse(fields);
      if (badField || !parsedFields.success) return reject("Check the form fields.");
      const name = uploadFileNameSchema.safeParse(info.filename);
      if (!name.success) return reject("The file name is not valid.");
      current = file;
      resolve({
        ok: true,
        upload: {
          threadId: parsedFields.data.thread_id,
          name: name.data,
          declaredMime: info.mimeType,
          file,
          finished,
        },
      });
    });
    parser.on("filesLimit", () => {
      extra = true;
    });
    parser.on("partsLimit", () => {
      badField = true;
    });
    parser.on("fieldsLimit", () => {
      badField = true;
    });
    parser.on("error", (err) => {
      current?.destroy(err as Error);
      fail(err);
      if (!opened) resolve({ ok: false, reason: "The multipart body is malformed." });
    });
    parser.on("close", () => {
      if (!opened) resolve({ ok: false, reason: "No file was sent." });
      settle({ extra });
    });
    body.once("error", (err) => parser.destroy(err));
    body.pipe(parser);
  });
}
