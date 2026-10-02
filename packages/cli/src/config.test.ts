import { describe, expect, it } from "vitest";
import { parseCommand } from "./config.js";

const S3 = {
  KOBE_S3_ENDPOINT: "https://s3.example.com",
  KOBE_S3_BUCKET: "kobe",
  KOBE_S3_ACCESS_KEY_ID: "AKIA",
  KOBE_S3_SECRET_ACCESS_KEY: "very-secret-value",
};
const BACKUP_URL = "postgres://kobe_backup:pw@db/kobe";
const OWNER_URL = "postgres://kobe_owner:pw@db/kobe";

describe("parseCommand", () => {
  it("parses backup with object storage", () => {
    const cmd = parseCommand(["backup", "--out", "/b/1"], {
      KOBE_BACKUP_DATABASE_URL: BACKUP_URL,
      ...S3,
    });
    expect(cmd).toMatchObject({
      command: "backup",
      out: "/b/1",
      databaseUrl: BACKUP_URL,
      s3: { bucket: "kobe", endpoint: "https://s3.example.com", region: "us-east-1", prefix: "" },
    });
  });

  it("requires object storage for backup unless --no-objects", () => {
    expect(() =>
      parseCommand(["backup", "--out", "/b/1"], { KOBE_BACKUP_DATABASE_URL: BACKUP_URL }),
    ).toThrow(/KOBE_S3_BUCKET.*--no-objects/);
    const cmd = parseCommand(["backup", "--out", "/b/1", "--no-objects"], {
      KOBE_BACKUP_DATABASE_URL: BACKUP_URL,
    });
    expect(cmd).toMatchObject({ command: "backup", s3: null });
  });

  it("parses restore with the owner URL", () => {
    const cmd = parseCommand(["restore", "--from", "/b/1", "--allow-missing-objects"], {
      KOBE_DB_MIGRATE_URL: OWNER_URL,
      ...S3,
    });
    expect(cmd).toMatchObject({
      command: "restore",
      from: "/b/1",
      databaseUrl: OWNER_URL,
      allowMissingObjects: true,
    });
  });

  it("explains missing settings without echoing secret values", () => {
    let message = "";
    try {
      parseCommand(["restore", "--from", "/b"], { ...S3, KOBE_DB_MIGRATE_URL: "mysql://x" });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/KOBE_DB_MIGRATE_URL/);
    expect(message).not.toContain("very-secret-value");
  });

  it("refuses credentials inside the S3 endpoint (they would land in the manifest)", () => {
    expect(() =>
      parseCommand(["backup", "--out", "/b"], {
        ...S3,
        KOBE_S3_ENDPOINT: "https://key:secret@s3.example.com",
        KOBE_BACKUP_DATABASE_URL: BACKUP_URL,
      }),
    ).toThrow(/KOBE_S3_ENDPOINT: must not contain credentials/);
  });

  it("rejects unknown commands and missing paths with usage", () => {
    expect(() => parseCommand(["frobnicate"], {})).toThrow(/Usage/);
    expect(() => parseCommand(["backup"], { KOBE_BACKUP_DATABASE_URL: BACKUP_URL })).toThrow(
      /--out/,
    );
    expect(() => parseCommand(["restore", "--from", "/b", "--bogus"], {})).toThrow(/bogus/);
  });
});
