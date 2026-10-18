// Copies a bucket's objects out of one S3 store and into another, for e2e/gate4-restore.sh
// (KOBE-233) on k3d, where the old cluster's S3 test fixture goes with the cluster: the restore
// then runs against "a bucket that holds a copy of its objects" (docs/backup-restore.md), as
// bucket replication would give a real site. Runs in a pod with the Kobe server image (its
// @aws-sdk/client-s3); reads KOBE_S3_ENDPOINT, _BUCKET, _REGION, _PREFIX, _ACCESS_KEY_ID,
// _SECRET_ACCESS_KEY from the environment.
//   export   prints one line per object: `obj <key base64> <size> <etag> <body base64>`
//   import   reads those lines on stdin, puts each object, prints `copied <key> <size> <etag-same>`
// and a summary line `objects=<n> bytes=<n> etag_mismatch=<n>`.
import { createRequire } from "node:module";

const require = createRequire("/app/package.json");
const {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
} = require("@aws-sdk/client-s3");

const MAX_BYTES = 512 * 1024 * 1024; // a test bucket; refuse anything larger than this
const env = process.env;
const Bucket = env.KOBE_S3_BUCKET;
if (!Bucket) throw new Error("KOBE_S3_BUCKET is not set");
const s3 = new S3Client({
  region: env.KOBE_S3_REGION || "us-east-1",
  forcePathStyle: (env.KOBE_S3_FORCE_PATH_STYLE ?? "true") === "true",
  ...(env.KOBE_S3_ENDPOINT ? { endpoint: env.KOBE_S3_ENDPOINT } : {}),
  ...(env.KOBE_S3_ACCESS_KEY_ID
    ? {
        credentials: {
          accessKeyId: env.KOBE_S3_ACCESS_KEY_ID,
          secretAccessKey: env.KOBE_S3_SECRET_ACCESS_KEY ?? "",
        },
      }
    : {}),
  requestChecksumCalculation: "WHEN_REQUIRED",
  responseChecksumValidation: "WHEN_REQUIRED",
});
const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
const unb64 = (s) => Buffer.from(s, "base64");

async function exportAll() {
  let token;
  let n = 0;
  let bytes = 0;
  do {
    const page = await s3.send(
      new ListObjectsV2Command({
        Bucket,
        Prefix: env.KOBE_S3_PREFIX || undefined,
        ...(token ? { ContinuationToken: token } : {}),
      }),
    );
    for (const o of page.Contents ?? []) {
      const got = await s3.send(new GetObjectCommand({ Bucket, Key: o.Key }));
      const body = Buffer.from(await got.Body.transformToByteArray());
      bytes += body.length;
      if (bytes > MAX_BYTES) throw new Error(`bucket holds more than ${MAX_BYTES} bytes`);
      process.stdout.write(
        `obj ${b64(o.Key)} ${body.length} ${(o.ETag ?? "-").replaceAll('"', "")} ${body.toString("base64")}\n`,
      );
      n += 1;
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  process.stderr.write(`exported objects=${n} bytes=${bytes}\n`);
}

async function importAll() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  let n = 0;
  let bytes = 0;
  let mismatch = 0;
  for (const line of Buffer.concat(chunks).toString("utf8").split("\n")) {
    if (!line.startsWith("obj ")) continue;
    const [, key64, size, etag, body64 = ""] = line.split(" ");
    const Key = unb64(key64).toString("utf8");
    const body = unb64(body64);
    if (body.length !== Number(size)) throw new Error(`object ${Key}: ${body.length} != ${size}`);
    await s3.send(new PutObjectCommand({ Bucket, Key, Body: body, ContentLength: body.length }));
    const head = await s3.send(new HeadObjectCommand({ Bucket, Key }));
    const same = (head.ETag ?? "").replaceAll('"', "") === etag;
    if (!same) mismatch += 1;
    console.log(`copied ${Key} ${body.length} etag-same=${same}`);
    n += 1;
    bytes += body.length;
  }
  console.log(`objects=${n} bytes=${bytes} etag_mismatch=${mismatch}`);
}

const mode = process.argv[1];
if (mode === "export") await exportAll();
else if (mode === "import") await importAll();
else {
  console.error("usage: s3-mirror.mjs export|import");
  process.exit(2);
}
