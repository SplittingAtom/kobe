import { describe, expect, it } from "vitest";
import { parsePaging, parseUserFilter } from "./filter.js";
import { addressFor, nameFrom, parsePatch, parseUserResource } from "./user-input.js";

const patch = (...Operations: unknown[]) => ({
  schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
  Operations,
});

describe("parseUserFilter", () => {
  it("reads the filters Entra sends", () => {
    expect(parseUserFilter('userName eq "Test_User_1"')).toEqual({
      ok: true,
      filter: { attribute: "userName", value: "Test_User_1" },
    });
    expect(parseUserFilter('externalId EQ "abc"')).toEqual({
      ok: true,
      filter: { attribute: "externalId", value: "abc" },
    });
    expect(parseUserFilter('urn:ietf:params:scim:schemas:core:2.0:User:userName eq "a"')).toEqual({
      ok: true,
      filter: { attribute: "userName", value: "a" },
    });
    expect(parseUserFilter('USERNAME eq "a\\"b"')).toEqual({
      ok: true,
      filter: { attribute: "userName", value: 'a"b' },
    });
    expect(parseUserFilter(undefined)).toEqual({ ok: true, filter: null });
  });

  it("refuses anything else instead of listing everyone", () => {
    for (const f of [
      'userName co "a"',
      'userName eq "a" or userName eq "b"',
      "userName eq a",
      'emails.value eq "a@b.c"',
      'displayName eq "a"',
      "userName pr",
    ]) {
      expect(parseUserFilter(f).ok, f).toBe(false);
    }
  });

  it("reads paging leniently", () => {
    expect(parsePaging(undefined, undefined)).toEqual({ startIndex: 1, count: 100 });
    expect(parsePaging("0", "-5")).toEqual({ startIndex: 1, count: 0 });
    expect(parsePaging("3", "1000")).toEqual({ startIndex: 3, count: 200 });
    expect(parsePaging("x", "2")).toEqual({ startIndex: 1, count: 2 });
  });
});

describe("parsePatch (Entra quirks)", () => {
  it("accepts op names in any case and string booleans", () => {
    expect(parsePatch(patch({ op: "Replace", path: "active", value: "False" }))).toEqual({
      ok: true,
      value: { active: false },
    });
    expect(parsePatch(patch({ op: "REPLACE", path: "active", value: "True" }))).toEqual({
      ok: true,
      value: { active: true },
    });
    expect(parsePatch(patch({ op: "replace", path: "active", value: false }))).toEqual({
      ok: true,
      value: { active: false },
    });
  });

  it("reads path-less value objects", () => {
    const r = parsePatch(
      patch({
        op: "Replace",
        value: {
          active: "False",
          displayName: "Ann Lee",
          "name.givenName": "Ann",
          'emails[type eq "work"].value': "ann@contoso.com",
          "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:department": "R&D",
          title: "Engineer",
        },
      }),
    );
    expect(r).toEqual({
      ok: true,
      value: {
        active: false,
        displayName: "Ann Lee",
        givenName: "Ann",
        email: "ann@contoso.com",
      },
    });
  });

  it("reads email paths and lists", () => {
    expect(
      parsePatch(
        patch(
          { op: "Replace", path: 'emails[type eq "work"].value', value: "a@b.com" },
          { op: "Replace", path: "name.familyName", value: "Lee" },
        ),
      ),
    ).toEqual({ ok: true, value: { email: "a@b.com", familyName: "Lee" } });
    expect(
      parsePatch(
        patch({
          op: "Add",
          path: "emails",
          value: [
            { type: "home", value: "h@b.com" },
            { type: "work", value: "w@b.com" },
          ],
        }),
      ),
    ).toEqual({ ok: true, value: { email: "w@b.com" } });
    expect(
      parsePatch(patch({ op: "Replace", path: "userName", value: "new@contoso.com" })),
    ).toEqual({ ok: true, value: { userName: "new@contoso.com" } });
  });

  it("ignores attributes Kobe doesn't keep and removals of them", () => {
    expect(
      parsePatch(
        patch(
          { op: "Remove", path: "title" },
          { op: "Add", path: 'addresses[type eq "work"].locality', value: "Paris" },
        ),
      ),
    ).toEqual({ ok: true, value: {} });
  });

  it("refuses malformed patches with RFC 7644 scimTypes", () => {
    expect(parsePatch({})).toMatchObject({ ok: false, scimType: "invalidSyntax" });
    expect(parsePatch(patch({ op: "Move", path: "active" }))).toMatchObject({
      ok: false,
      scimType: "invalidSyntax",
    });
    expect(parsePatch(patch({ op: "Remove" }))).toMatchObject({ ok: false, scimType: "noTarget" });
    expect(parsePatch(patch({ op: "Remove", path: "userName" }))).toMatchObject({
      ok: false,
      scimType: "mutability",
    });
    expect(parsePatch(patch({ op: "Replace", path: "active", value: "maybe" }))).toMatchObject({
      ok: false,
      scimType: "invalidValue",
    });
    expect(parsePatch(patch({ op: "Replace", value: "x" }))).toMatchObject({
      ok: false,
      scimType: "invalidValue",
    });
    expect(
      parsePatch(patch(...Array.from({ length: 101 }, () => ({ op: "add", path: "title" })))),
    ).toMatchObject({ ok: false, scimType: "tooMany" });
  });
});

describe("parseUserResource", () => {
  it("reads Microsoft's validator-style create body", () => {
    const r = parseUserResource({
      schemas: [
        "urn:ietf:params:scim:schemas:core:2.0:User",
        "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User",
      ],
      externalId: "0a21f0f2-8d2a-4f8e-bf98-7363c4aed4ef",
      userName: "Test_User_ab6490ee",
      active: true,
      emails: [{ primary: true, type: "work", value: "Test_User_fd0e@testuser.com" }],
      meta: { resourceType: "User" },
      name: { formatted: "givenName familyName", familyName: "familyName", givenName: "givenName" },
      roles: [],
    });
    expect(r).toEqual({
      ok: true,
      value: {
        externalId: "0a21f0f2-8d2a-4f8e-bf98-7363c4aed4ef",
        userName: "Test_User_ab6490ee",
        active: true,
        email: "Test_User_fd0e@testuser.com",
        formatted: "givenName familyName",
        familyName: "familyName",
        givenName: "givenName",
      },
    });
  });

  it("needs a userName and leaves active unset unless given", () => {
    expect(parseUserResource({ externalId: "x" })).toMatchObject({
      ok: false,
      scimType: "invalidValue",
    });
    expect(parseUserResource({ userName: "a@b.com", active: "False" })).toMatchObject({
      ok: true,
      value: { active: false },
    });
    expect(parseUserResource({ userName: "a@b.com" })).toEqual({
      ok: true,
      value: { userName: "a@b.com" },
    });
  });
});

describe("addressFor and nameFrom", () => {
  it("prefers an address userName, else the work email", () => {
    expect(addressFor("Ann@Contoso.com", "x@y.com")).toBe("ann@contoso.com");
    expect(addressFor("Test_User_1", "W@Y.com")).toBe("w@y.com");
    expect(addressFor("Test_User_1", null)).toBeUndefined();
  });

  it("builds a name, and a single changed part keeps the name", () => {
    expect(nameFrom({ displayName: "D", formatted: "F" })).toBe("D");
    expect(nameFrom({ givenName: "A", familyName: "B" })).toBe("A B");
    expect(nameFrom({ familyName: "B" })).toBe("B");
    expect(nameFrom({ familyName: "B" }, true)).toBeUndefined();
  });
});
