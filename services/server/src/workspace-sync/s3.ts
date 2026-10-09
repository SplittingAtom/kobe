import { Readable } from "node:stream";
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { z } from "zod";
import type { ObjectStore } from "./object-store.js";

/**
 * S3-compatible object storage from the chart's `s3` values (spec D4: an external endpoint; the
 * chart bundles none — MinIO is AGPL). The server is the only Kobe component holding these
 * credentials; sandboxes never see them (KOBE-27).
 */
const settingsSchema = z
  .object({
    KOBE_S3_BUCKET: z.string().trim().default(""),
    KOBE_S3_ENDPOINT: z
      .string()
      .trim()
      .default("")
      .refine((v) => v === "" || /^https?:\/\/[^/@]+(\/.*)?$/.test(v), {
        message: "KOBE_S3_ENDPOINT must be an http(s) URL without credentials",
      }),
    KOBE_S3_REGION: z.string().trim().min(1).default("us-east-1"),
    KOBE_S3_FORCE_PATH_STYLE: z
      .enum(["true", "false", ""])
      .default("true")
      .transform((v) => v !== "false"),
    KOBE_S3_PREFIX: z
      .string()
      .trim()
      .default("")
      .refine((v) => v === "" || (/^[A-Za-z0-9!_.*'()/-]+\/$/.test(v) && !v.startsWith("/")), {
        message: "KOBE_S3_PREFIX must be a relative key prefix ending in /",
      }),
    KOBE_S3_ACCESS_KEY_ID: z.string().default(""),
    KOBE_S3_SECRET_ACCESS_KEY: z.string().default(""),
  })
  .refine((e) => (e.KOBE_S3_ACCESS_KEY_ID === "") === (e.KOBE_S3_SECRET_ACCESS_KEY === ""), {
    message: "KOBE_S3_ACCESS_KEY_ID and KOBE_S3_SECRET_ACCESS_KEY must be set together",
  });

export interface S3Settings {
  readonly bucket: string;
  readonly endpoint: string | undefined;
  readonly region: string;
  readonly forcePathStyle: boolean;
  readonly prefix: string;
  /** Absent: the SDK's default credential chain. */
  readonly credentials: { readonly accessKeyId: string; readonly secretAccessKey: string } | null;
}

/** Undefined when no bucket is configured (workspace sync then stays off); throws when invalid. */
export function loadS3Settings(
  env: Readonly<Record<string, string | undefined>>,
): S3Settings | undefined {
  const parsed = settingsSchema.safeParse(env);
  if (!parsed.success) {
    // Messages only: never echo values (credentials).
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const e = parsed.data;
  if (e.KOBE_S3_BUCKET === "") return undefined;
  return {
    bucket: e.KOBE_S3_BUCKET,
    endpoint: e.KOBE_S3_ENDPOINT === "" ? undefined : e.KOBE_S3_ENDPOINT,
    region: e.KOBE_S3_REGION,
    forcePathStyle: e.KOBE_S3_FORCE_PATH_STYLE,
    prefix: e.KOBE_S3_PREFIX,
    credentials:
      e.KOBE_S3_ACCESS_KEY_ID === ""
        ? null
        : { accessKeyId: e.KOBE_S3_ACCESS_KEY_ID, secretAccessKey: e.KOBE_S3_SECRET_ACCESS_KEY },
  };
}

function isNotFound(err: unknown): boolean {
  return (
    err instanceof NoSuchKey ||
    (err instanceof S3ServiceException &&
      (err.name === "NoSuchKey" || err.name === "NotFound" || err.$metadata.httpStatusCode === 404))
  );
}

const PART_BYTES = 8 * 1024 * 1024;
const QUEUE_SIZE = 2;

export function createS3ObjectStore(settings: S3Settings, client?: S3Client): ObjectStore {
  const s3 =
    client ??
    new S3Client({
      region: settings.region,
      forcePathStyle: settings.forcePathStyle,
      ...(settings.endpoint ? { endpoint: settings.endpoint } : {}),
      ...(settings.credentials ? { credentials: settings.credentials } : {}),
      // Plain requests that S3-compatible stores understand: no aws-chunked trailing checksums.
      // Integrity is the server's own SHA-256 check on the way in (verifyingStream).
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });
  const Bucket = settings.bucket;
  return {
    async put(key, body, size) {
      // A body that errors (a failed hash check) must abort the request: piping does not forward
      // the error, and S3 would wait for the bytes it was promised.
      const abort = new AbortController();
      let failure: unknown;
      const onError = (err: unknown) => {
        failure = err;
        abort.abort(err);
      };
      body.once("error", onError);
      try {
        await s3.send(new PutObjectCommand({ Bucket, Key: key, Body: body, ContentLength: size }), {
          abortSignal: abort.signal,
        });
      } catch (err) {
        throw failure ?? err;
      } finally {
        body.off("error", onError);
      }
      if (failure !== undefined) throw failure;
    },
    async putStream(key, body) {
      // Multipart: parts are buffered (PART_BYTES x QUEUE_SIZE in flight), never the whole body.
      // A failing body aborts the upload and the parts already sent.
      const upload = new Upload({
        client: s3,
        params: { Bucket, Key: key, Body: body },
        partSize: PART_BYTES,
        queueSize: QUEUE_SIZE,
        leavePartsOnError: false,
      });
      const onError = () => void upload.abort();
      body.once("error", onError);
      try {
        await upload.done();
      } finally {
        body.off("error", onError);
      }
    },
    async get(key) {
      try {
        const out = await s3.send(new GetObjectCommand({ Bucket, Key: key }));
        if (!(out.Body instanceof Readable)) throw new Error("S3 GetObject returned no stream");
        return { body: out.Body, size: out.ContentLength ?? 0 };
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
    },
    async copy(from, to) {
      await s3.send(
        new CopyObjectCommand({
          Bucket,
          Key: to,
          CopySource: `${Bucket}/${from.split("/").map(encodeURIComponent).join("/")}`,
        }),
      );
    },
    async delete(keys) {
      // One by one: DeleteObjects requires a body checksum some S3-compatible stores reject.
      for (const Key of keys) await s3.send(new DeleteObjectCommand({ Bucket, Key }));
    },
  };
}
