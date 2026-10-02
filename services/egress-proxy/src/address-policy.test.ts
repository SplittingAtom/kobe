import { describe, expect, it } from "vitest";
import { AddressPolicy, validateCidrs } from "./address-policy.js";

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
      "192.168.1.81",
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

  it("refuses IPv6 forms that embed an IPv4 address (mapped, NAT64, 6to4, Teredo)", () => {
    for (const ip of [
      "::ffff:10.0.0.1",
      "::ffff:8.8.8.8",
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
});
