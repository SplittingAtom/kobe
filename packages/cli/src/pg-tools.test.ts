import { describe, expect, it } from "vitest";
import { libpqConnection, parseMajorVersion, pgBinary } from "./pg-tools.js";

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
