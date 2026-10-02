import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { keyFileWarning, parseCommand, readBackupKey, tlsWarning } from "./config.js";

const S3 = {
  KOBE_S3_ENDPOINT: "https://s3.example.com",
  KOBE_S3_BUCKET: "kobe",
  KOBE_S3_ACCESS_KEY_ID: "AKIA",
  KOBE_S3_SECRET_ACCESS_KEY: "very-secret-value",
};
const KEY = randomBytes(32);
const KEY_ENV = { KOBE_BACKUP_KEY: KEY.toString("base64") };
const BACKUP_URL = "postgres://kobe_backup:pw@db/kobe";
const OWNER_URL = "postgres://kobe_owner:pw@db/kobe";

describe("parseCommand", () => {
  it("parses backup with object storage", () => {
    const cmd = parseCommand(["backup", "--out", "/b/1"], {
      KOBE_BACKUP_DATABASE_URL: BACKUP_URL,
      ...S3,
      ...KEY_ENV,
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
      parseCommand(["backup", "--out", "/b/1"], {
        KOBE_BACKUP_DATABASE_URL: BACKUP_URL,
        ...KEY_ENV,
      }),
    ).toThrow(/KOBE_S3_BUCKET.*--no-objects/);
    const cmd = parseCommand(["backup", "--out", "/b/1", "--no-objects"], {
      KOBE_BACKUP_DATABASE_URL: BACKUP_URL,
      ...KEY_ENV,
    });
    expect(cmd).toMatchObject({ command: "backup", s3: null });
  });

  it("parses restore with the owner URL", () => {
    const cmd = parseCommand(["restore", "--from", "/b/1", "--allow-object-mismatch"], {
      KOBE_DB_MIGRATE_URL: OWNER_URL,
      ...S3,
      ...KEY_ENV,
    });
    expect(cmd).toMatchObject({
      command: "restore",
      from: "/b/1",
      databaseUrl: OWNER_URL,
      allowObjectMismatch: true,
      skipObjects: false,
    });
    expect(cmd.key.equals(KEY)).toBe(true);
  });

  it("restore --no-objects skips object storage even when configured", () => {
    const cmd = parseCommand(["restore", "--from", "/b", "--no-objects"], {
      KOBE_DB_MIGRATE_URL: OWNER_URL,
      ...S3,
      ...KEY_ENV,
    });
    expect(cmd).toMatchObject({ s3: null, skipObjects: true, tmpDir: undefined });
    const withTmp = parseCommand(["restore", "--from", "/b"], {
      KOBE_DB_MIGRATE_URL: OWNER_URL,
      KOBE_TMPDIR: "/dev/shm",
      ...KEY_ENV,
    });
    expect(withTmp).toMatchObject({ tmpDir: "/dev/shm" });
  });

  it("refuses a password in the query string", () => {
    expect(() =>
      parseCommand(["restore", "--from", "/b"], {
        KOBE_DB_MIGRATE_URL: "postgres://u@db/kobe?password=pw",
        ...KEY_ENV,
      }),
    ).toThrow(/not in \?password=/);
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
        ...KEY_ENV,
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

describe("readBackupKey", () => {
  const never = (): string => {
    throw new Error("unexpected read");
  };

  it("reads the key from a file or the environment", () => {
    expect(
      readBackupKey({ KOBE_BACKUP_KEY_FILE: "/k" }, () => KEY.toString("hex")).equals(KEY),
    ).toBe(true);
    expect(readBackupKey(KEY_ENV, never).equals(KEY)).toBe(true);
  });

  it("requires exactly one source, and never echoes the key", () => {
    expect(() => readBackupKey({}, never)).toThrow(/always encrypted and signed/);
    expect(() => readBackupKey({ ...KEY_ENV, KOBE_BACKUP_KEY_FILE: "/k" }, never)).toThrow(
      /not both/,
    );
    expect(() => readBackupKey({ KOBE_BACKUP_KEY_FILE: "/missing" }, never)).toThrow(
      /could not be read/,
    );
    let message = "";
    try {
      readBackupKey({ KOBE_BACKUP_KEY: "dG9vLXNob3J0" }, never);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/at least 32 bytes/);
    expect(message).not.toContain("dG9vLXNob3J0");
  });
});

describe("tlsWarning", () => {
  it("is quiet for local connections and TLS-required remote ones", () => {
    expect(tlsWarning("postgres://u:p@localhost:5432/kobe")).toBeNull();
    expect(tlsWarning("postgres://u:p@127.0.0.1/kobe")).toBeNull();
    expect(tlsWarning("postgres://u:p@db.example/kobe?sslmode=verify-full")).toBeNull();
  });

  it("warns for a remote host without required TLS", () => {
    expect(tlsWarning("postgres://u:p@db.example/kobe")).toMatch(/db.example.*sslmode=require/);
    expect(tlsWarning("postgres://u:p@db.example/kobe?sslmode=prefer")).toMatch(/WARNING/);
  });
});

describe("keyFileWarning", () => {
  it("warns when the key file is group or world readable", () => {
    expect(keyFileWarning({ KOBE_BACKUP_KEY_FILE: "/k" }, () => 0o100600)).toBeNull();
    expect(keyFileWarning({ KOBE_BACKUP_KEY_FILE: "/k" }, () => 0o100644)).toMatch(
      /mode 644.*chmod 600/,
    );
    expect(keyFileWarning({ KOBE_BACKUP_KEY_FILE: "/k" }, () => 0o100640)).toMatch(/WARNING/);
    expect(keyFileWarning(KEY_ENV, () => 0o100644)).toBeNull();
  });
});
