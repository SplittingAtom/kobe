import type { ListObjectsV2Command } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import type { S3Settings } from "./config.js";
import { collect } from "./objects.js";
import { s3Lister, type ListClient } from "./s3.js";

const settings: S3Settings = {
  endpoint: "https://s3.example.com",
  region: "us-east-1",
  bucket: "kobe",
  prefix: "data/",
  forcePathStyle: true,
  credentials: { accessKeyId: "a", secretAccessKey: "b" },
};

describe("s3Lister", () => {
  it("follows continuation tokens and passes bucket and prefix", async () => {
    const seen: ListObjectsV2Command["input"][] = [];
    const client: ListClient = {
      send: (cmd: ListObjectsV2Command) => {
        seen.push(cmd.input);
        return Promise.resolve(
          cmd.input.ContinuationToken
            ? { Contents: [{ Key: "data/b", Size: 2, ETag: '"b"' }], IsTruncated: false }
            : {
                Contents: [{ Key: "data/a", Size: 1, ETag: '"a"' }],
                IsTruncated: true,
                NextContinuationToken: "t1",
              },
        );
      },
    };
    const lister = s3Lister(settings, client);
    expect(await collect(lister)).toEqual([
      { key: "data/a", size: 1, etag: '"a"' },
      { key: "data/b", size: 2, etag: '"b"' },
    ]);
    expect(seen).toEqual([
      { Bucket: "kobe", Prefix: "data/" },
      { Bucket: "kobe", Prefix: "data/", ContinuationToken: "t1" },
    ]);
    expect(lister.location).toEqual({
      endpoint: "https://s3.example.com",
      bucket: "kobe",
      prefix: "data/",
    });
  });

  it("fails rather than returning a partial listing", async () => {
    const client: ListClient = {
      send: () => Promise.resolve({ Contents: [], IsTruncated: true }),
    };
    await expect(collect(s3Lister(settings, client))).rejects.toThrow(/truncated/);
  });
});
