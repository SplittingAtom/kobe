import { describe, expect, it } from "vitest";
import { AddressPolicy, validateCidrs, validateInternalTargets } from "./index.js";

describe("AddressPolicy", () => {
  const policy = new AddressPolicy();

  it("allows global unicast addresses", () => {
    for (const ip of ["151.101.0.223", "1.1.1.1", "2606:4700:4700::1111"]) {
      expect(policy.check(ip), ip).toBe("allowed");
    }
  });

  it("refuses private, loopback, link-local, metadata, CGNAT, multicast and reserved ranges", () => {
    for (const ip of [
      "10.43.0.1",
      "172.16.5.4",
      "192.168.0.10",
      "127.0.0.1",
      "127.1.2.3",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "224.0.0.1",
      "255.255.255.255",
      "198.18.0.1",
      "::1",
      "::",
      "fe80::1",
      "fd00:ec2::254",
      "fc00::1",
      "ff02::1",
    ]) {
      expect(policy.check(ip), ip).toBe("forbidden");
    }
  });

  it("refuses IPv6 forms that embed an IPv4 address (mapped, compatible, NAT64, 6to4, Teredo)", () => {
    for (const ip of [
      "::ffff:10.0.0.1",
      "::ffff:8.8.8.8",
      "::a00:1",
      "::8.8.8.8",
      "64:ff9b::a00:1",
      "2002:a00:1::1",
      "2001::1",
    ]) {
      expect(policy.check(ip), ip).toBe("forbidden");
    }
  });

  it("refuses anything that is not an IP address", () => {
    expect(policy.check("example.com")).toBe("forbidden");
    expect(policy.check("")).toBe("forbidden");
  });

  it("refuses a name when any one of its addresses is forbidden (rebinding to internal)", () => {
    expect(policy.checkAll(["1.1.1.1", "10.0.0.1"])).toBe("forbidden");
    expect(policy.checkAll(["1.1.1.1", "8.8.8.8"])).toBe("allowed");
    expect(policy.checkAll([])).toBe("forbidden");
  });

  it("adds cluster ranges and lets operators allow explicit internal targets", () => {
    const custom = new AddressPolicy({
      extraDenied: ["11.0.0.0/8"],
      allowedInternal: ["10.43.200.200/32"],
    });
    expect(custom.check("11.1.2.3")).toBe("forbidden");
    expect(custom.check("10.43.200.200")).toBe("allowed");
    expect(custom.check("10.43.200.201")).toBe("forbidden");
  });

  it("rejects invalid CIDRs in configuration", () => {
    expect(() => validateCidrs(["10.0.0.0/33"])).toThrow(/invalid CIDR/);
    expect(() => validateCidrs(["nope"])).toThrow(/invalid CIDR/);
    expect(() => validateCidrs(["10.0.0.0/8", "fd00::/8"])).not.toThrow();
  });

  it("refuses the documentation, SRv6 and ORCHIDv2 IPv6 ranges (KOBE-58 review L6)", () => {
    const policy = new AddressPolicy();
    for (const ip of ["3fff::1", "3fff:fff:ffff::1", "5f00::1", "2001:20::1", "2001:2f::1"]) {
      expect(policy.check(ip), ip).toBe("forbidden");
    }
    expect(policy.check("2600::1")).toBe("allowed");
  });

  describe("internal targets (EA4, KOBE-603)", () => {
    const policy = new AddressPolicy({
      internalTargets: ["192.0.2.10/32", "198.51.100.0/24", "fd12:3456::/48"],
    });
    const internal = { internal: true };

    it("allows an internal target only for a host matched by an internal pattern", () => {
      for (const ip of ["192.0.2.10", "198.51.100.7", "fd12:3456::1"]) {
        expect(policy.check(ip, internal), ip).toBe("allowed");
        expect(policy.check(ip), ip).toBe("forbidden");
        expect(policy.check(ip, { internal: false }), ip).toBe("forbidden");
      }
    });

    it("refuses internal addresses outside the targets, even for an internal pattern", () => {
      for (const ip of ["192.0.2.11", "10.0.0.1", "172.16.5.4", "fd12:3457::1", "fc00::1"]) {
        expect(policy.check(ip, internal), ip).toBe("forbidden");
      }
    });

    it("keeps global addresses allowed for internal patterns (mixed resolution)", () => {
      expect(policy.checkAll(["1.1.1.1", "192.0.2.10"], internal)).toBe("allowed");
      expect(policy.checkAll(["2606:4700:4700::1111", "fd12:3456::9"], internal)).toBe("allowed");
      expect(policy.checkAll(["1.1.1.1", "192.0.2.10"])).toBe("forbidden");
      // One address outside the targets refuses the whole name.
      expect(policy.checkAll(["192.0.2.10", "10.0.0.1"], internal)).toBe("forbidden");
      expect(policy.checkAll([], internal)).toBe("forbidden");
    });

    it("refuses metadata, loopback and link-local always, even when a target covers them", () => {
      const broad = new AddressPolicy({
        internalTargets: ["127.0.0.0/8", "169.254.0.0/16", "100.64.0.0/10", "::/0", "fd00::/8"],
      });
      for (const ip of [
        "127.0.0.1",
        "169.254.169.254",
        "169.254.1.1",
        "100.100.100.200",
        "::1",
        "::",
        "fe80::1",
        "fd00:ec2::254",
        "::ffff:127.0.0.1",
        "::ffff:169.254.169.254",
        "64:ff9b::a9fe:a9fe",
        "ff02::1",
      ]) {
        expect(broad.check(ip, internal), ip).toBe("forbidden");
      }
      // The same broad list still reaches ordinary internal addresses it covers.
      expect(broad.check("100.64.0.1", internal)).toBe("allowed");
      expect(broad.check("fd00:1::1", internal)).toBe("allowed");
    });

    it("validates the target list: CIDRs only, none starting in an always-refused range", () => {
      expect(() => validateInternalTargets(["192.0.2.10/32", "fd12:3456::/48"])).not.toThrow();
      expect(() => validateInternalTargets(["192.0.2.10"])).not.toThrow();
      for (const bad of [
        "nope",
        "10.0.0.0/33",
        "0.0.0.0/0",
        "::/0",
        "127.0.0.1/32",
        "169.254.169.254/32",
        "fe80::/10",
        "::ffff:10.0.0.1/128",
      ]) {
        expect(() => validateInternalTargets([bad]), bad).toThrow();
      }
    });
  });
});
