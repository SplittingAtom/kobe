import { describe, expect, it } from "vitest";
import {
  childEnv,
  libpqConnection,
  parseMajorVersion,
  parseVersion,
  pgBinary,
  safePsqlErrors,
  safeToolErrors,
  supportsRestrict,
} from "./pg-tools.js";

describe("libpqConnection", () => {
  it("moves the password out of the URL (never on a command line)", () => {
    const c = libpqConnection(
      "postgres://kobe_owner:p%40ss%3Aword@db.example:5432/kobe?sslmode=require",
    );
    expect(c.dbname).toBe("postgres://kobe_owner@db.example:5432/kobe?sslmode=require");
    expect(c.dbname).not.toContain("p%40ss");
    expect(c.env).toEqual({ PGPASSWORD: "p@ss:word" });
  });

  it("leaves a URL without a password alone", () => {
    const c = libpqConnection("postgresql://u@h/db");
    expect(c.dbname).toBe("postgresql://u@h/db");
    expect(c.env).toEqual({});
  });
});

describe("parseMajorVersion", () => {
  it.each([
    ["pg_dump (PostgreSQL) 18.6", 18],
    ["pg_restore (PostgreSQL) 17.2 (Debian 17.2-1.pgdg120+1)", 17],
    ["psql (PostgreSQL) 17beta1", 17],
  ])("%s → %d", (text, major) => {
    expect(parseMajorVersion(text)).toBe(major);
  });

  it("throws on unrecognized output", () => {
    expect(() => parseMajorVersion("hello")).toThrow(/version/);
  });
});

describe("pgBinary", () => {
  it("uses PATH by default and a directory when given", () => {
    expect(pgBinary("pg_dump")).toBe("pg_dump");
    expect(pgBinary("psql", "/usr/lib/postgresql/17/bin")).toBe("/usr/lib/postgresql/17/bin/psql");
  });
});

describe("childEnv", () => {
  it("passes only what libpq and the OS need, never S3 or Kobe secrets", () => {
    const env = childEnv(
      {
        PATH: "/usr/bin",
        HOME: "/home/op",
        LANG: "C.UTF-8",
        PGSSLMODE: "verify-full",
        PGPASSWORD: "inherited",
        KOBE_S3_SECRET_ACCESS_KEY: "s3-secret",
        KOBE_BACKUP_KEY: "backup-key",
        AWS_SECRET_ACCESS_KEY: "aws",
      },
      { PGPASSWORD: "from-url" },
    );
    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/op",
      LANG: "C.UTF-8",
      PGSSLMODE: "verify-full",
      PGPASSWORD: "from-url",
    });
  });
});

describe("parseVersion / supportsRestrict", () => {
  it.each([
    ["pg_restore (PostgreSQL) 18.6", true],
    ["psql (PostgreSQL) 17.6 (Debian 17.6-1.pgdg120+1)", true],
    ["psql (PostgreSQL) 17.5", false],
    ["psql (PostgreSQL) 16.9", false],
  ])("%s → %s", (text, ok) => {
    expect(supportsRestrict(parseVersion(text))).toBe(ok);
  });
});

describe("safeToolErrors", () => {
  it("keeps error lines, drops detail lines that can carry row data", () => {
    const stderr = [
      'pg_dump: error: Dumping the contents of table "users" failed: PQgetResult() failed.',
      "pg_dump: detail: Error message from server: ERROR:  invalid input value: ann@example.com",
      "pg_dump: detail: Command was: COPY public.users (id, email) TO stdout;",
    ].join("\n");
    expect(safeToolErrors(stderr)).toBe(
      'pg_dump: error: Dumping the contents of table "users" failed: PQgetResult() failed.',
    );
  });
});

describe("safePsqlErrors", () => {
  it("shows Kobe's own checks, and only the SQLSTATE for other errors", () => {
    const stderr = [
      "psql:<stdin>:12: ERROR:  P0001: kobe restore: widgets has 3 rows, the backup has 4; nothing was restored",
      'psql:<stdin>:40: ERROR:  23505: duplicate key value violates unique constraint "users_email_unique"',
      "DETAIL:  Key (email)=(ann@example.com) already exists.",
      "CONTEXT:  COPY users, line 1",
      "LOCATION:  _bt_check_unique, nbtinsert.c:666",
      'psql: error: connection to server at "db" (10.0.0.1), port 5432 failed: FATAL:  password authentication failed for user "kobe_owner"',
    ].join("\n");
    const out = safePsqlErrors(stderr);
    expect(out).toContain("kobe restore: widgets has 3 rows, the backup has 4");
    expect(out).toContain("ERROR 23505");
    expect(out).toContain("password authentication failed");
    expect(out).not.toContain("ann@example.com");
    expect(out).not.toContain("users_email_unique");
  });
});
