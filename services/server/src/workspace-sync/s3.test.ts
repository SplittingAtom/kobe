import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeS3 } from "../testing/fake-s3.js";
import { IntegrityError, verifyingStream } from "./object-store.js";
import { createS3ObjectStore, loadS3Settings } from "./s3.js";

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const text = async (r: Readable) => {
  const chunks: Buffer[] = [];
  for await (const c of r) chunks.push(Buffer.from(c as Uint8Array));
  return Buffer.concat(chunks).toString();
};

describe("loadS3Settings", () => {
  it("is off without a bucket and parses the chart's env", () => {
    expect(loadS3Settings({})).toBeUndefined();
    expect(
      loadS3Settings({
        KOBE_S3_BUCKET: "kobe",
        KOBE_S3_ENDPOINT: "http://s3.kobe-deps:8333",
        KOBE_S3_FORCE_PATH_STYLE: "true",
        KOBE_S3_ACCESS_KEY_ID: "id",
        KOBE_S3_SECRET_ACCESS_KEY: "secret",
      }),
    ).toEqual({
      bucket: "kobe",
      endpoint: "http://s3.kobe-deps:8333",
      region: "us-east-1",
      forcePathStyle: true,
      prefix: "",
      credentials: { accessKeyId: "id", secretAccessKey: "secret" },
    });
  });

  it("refuses credentials in the endpoint and half-set keys, without echoing them", () => {
    const bad = () =>
      loadS3Settings({ KOBE_S3_BUCKET: "b", KOBE_S3_ENDPOINT: "http://user:hunter2@s3" });
    expect(bad).toThrow(/without credentials/);
    expect(bad).not.toThrow(/hunter2/);
    expect(() => loadS3Settings({ KOBE_S3_BUCKET: "b", KOBE_S3_ACCESS_KEY_ID: "x" })).toThrow(
      /set together/,
    );
    expect(() => loadS3Settings({ KOBE_S3_BUCKET: "b", KOBE_S3_PREFIX: "/abs/" })).toThrow();
  });
});

describe("verifyingStream", () => {
  it("passes matching bytes and withholds the last chunk on a mismatch", async () => {
    const data = Buffer.from("hello workspace");
    await expect(
      text(Readable.from([data]).pipe(verifyingStream(sha(data), data.length))),
    ).resolves.toBe("hello workspace");
    const out: Buffer[] = [];
    const bad = Readable.from([Buffer.from("hello "), Buffer.from("tampered")]).pipe(
      verifyingStream(sha(data), 14),
    );
    bad.on("data", (c: Buffer) => out.push(c));
    await expect(new Promise((_, reject) => bad.on("error", reject))).rejects.toBeInstanceOf(
      IntegrityError,
    );
    expect(Buffer.concat(out).toString()).toBe("hello ");
  });

  it("errors as soon as more bytes than declared arrive", async () => {
    const s = Readable.from([Buffer.alloc(10)]).pipe(verifyingStream("0".repeat(64), 5));
    await expect(text(s)).rejects.toThrow(/size_mismatch/);
  });
});

describe("S3 object store (fake S3 over HTTP)", () => {
  const fake = new FakeS3("kobe", "test-key");
  let store: ReturnType<typeof createS3ObjectStore>;

  beforeAll(async () => {
    const endpoint = await fake.start();
    store = createS3ObjectStore({
      bucket: "kobe",
      endpoint,
      region: "us-east-1",
      forcePathStyle: true,
      prefix: "",
      credentials: { accessKeyId: "test-key", secretAccessKey: "test-secret" },
    });
  });
  afterAll(() => fake.stop());

  it("puts a stream, gets, copies and deletes", async () => {
    const data = Buffer.from("a".repeat(100_000));
    await store.put("teams/t/a", Readable.from([data]), data.length);
    expect(fake.objects.get("teams/t/a")?.equals(data)).toBe(true);
    const got = await store.get("teams/t/a");
    expect(got?.size).toBe(data.length);
    expect(await text(got?.body ?? Readable.from([]))).toBe(data.toString());
    await store.copy("teams/t/a", "teams/t/shared/b");
    expect(fake.objects.get("teams/t/shared/b")?.length).toBe(data.length);
    await store.delete(["teams/t/a", "teams/t/missing"]);
    expect(await store.get("teams/t/a")).toBeNull();
  });

  it("stores nothing when the verified upload fails", async () => {
    const good = Buffer.from("good content");
    const stream = Readable.from([Buffer.from("evil content")]).pipe(
      verifyingStream(sha(good), good.length),
    );
    await expect(store.put("teams/t/evil", stream, good.length)).rejects.toThrow();
    expect(fake.objects.has("teams/t/evil")).toBe(false);
  });

  it("streams a body of unknown length, and stores nothing when the body fails", async () => {
    await store.putStream("teams/t/stream", Readable.from([Buffer.from("ab"), Buffer.from("cd")]));
    expect(fake.objects.get("teams/t/stream")?.toString()).toBe("abcd");
    const failing = new Readable({
      read() {
        this.push(Buffer.from("partial"));
        this.destroy(new Error("client went away"));
      },
    });
    await expect(store.putStream("teams/t/broken", failing)).rejects.toThrow();
    expect(fake.objects.has("teams/t/broken")).toBe(false);
  });
});

describe("list", () => {
  it("maps ListObjectsV2 pages, prefixes and the continuation token", async () => {
    const sent: unknown[] = [];
    const client = {
      send: (cmd: { input: unknown }) => {
        sent.push(cmd.input);
        return Promise.resolve({
          Contents: [{ Key: "p/a", LastModified: new Date(1000) }, { LastModified: new Date() }],
          CommonPrefixes: [{ Prefix: "p/d/" }],
          IsTruncated: true,
          NextContinuationToken: "tok",
        });
      },
    };
    const store = createS3ObjectStore(
      {
        bucket: "b",
        endpoint: undefined,
        region: "r",
        forcePathStyle: true,
        prefix: "",
        credentials: null,
      },
      client as never,
    );
    const page = await store.list("p/", { limit: 5, cursor: "c", delimiter: "/" });
    expect(page).toEqual({
      objects: [{ key: "p/a", lastModified: new Date(1000) }],
      prefixes: ["p/d/"],
      next: "tok",
    });
    expect(sent).toEqual([
      { Bucket: "b", Prefix: "p/", MaxKeys: 5, ContinuationToken: "c", Delimiter: "/" },
    ]);
  });
});
