import { describe, expect, it } from "vitest";
import { classifyPackages, packageKey, parseLockfile, splitKey } from "./lockfile.js";

const LOCK = `---
lockfileVersion: '9.0'
importers:
  .:
    packageManagerDependencies:
      pnpm: { specifier: 12.8.1, version: 12.8.1 }
packages:
  pnpm@12.8.1: { resolution: { integrity: x } }
snapshots:
  pnpm@12.8.1: {}
---
lockfileVersion: '9.0'
importers:
  .:
    devDependencies:
      vitest: { specifier: ^5, version: 5.0.3 }
  apps/web:
    dependencies:
      '@kobe/protocol': { specifier: 'workspace:*', version: 'link:../../packages/protocol' }
      auth: { specifier: ^1, version: 1.0.0(vitest@5.0.3) }
      native: { specifier: ^1, version: 1.0.0 }
      string-width-cjs: { specifier: npm:string-width@4.2.3, version: string-width@4.2.3 }
  packages/protocol:
    dependencies:
      zod: { specifier: ^4, version: 4.0.0 }
packages:
  vitest@5.0.3: { resolution: { integrity: x } }
  auth@1.0.0:
    resolution: { integrity: x }
    peerDependencies: { vitest: '*' }
  native@1.0.0: { resolution: { integrity: x } }
  native-linux-x64@1.0.0:
    resolution: { integrity: x }
    cpu: [x64]
    os: [linux]
  wasm-helper@1.0.0: { resolution: { integrity: x } }
  string-width@4.2.3: { resolution: { integrity: x } }
  zod@4.0.0: { resolution: { integrity: x } }
snapshots:
  vitest@5.0.3: {}
  auth@1.0.0(vitest@5.0.3):
    dependencies:
      vitest: 5.0.3
  native@1.0.0:
    optionalDependencies:
      native-linux-x64: 1.0.0
  native-linux-x64@1.0.0:
    dependencies:
      wasm-helper: 1.0.0
  wasm-helper@1.0.0: {}
  string-width@4.2.3: {}
  zod@4.0.0: {}
`;

describe("lockfile keys", () => {
  it("strips peer suffixes and splits scoped names", () => {
    expect(packageKey("next@16.3.8(react@19.3.0)(react-dom@19.3.0(react@19.3.0))")).toBe(
      "next@16.3.8",
    );
    expect(splitKey("@scope/pkg@1.2.3")).toEqual({ name: "@scope/pkg", version: "1.2.3" });
  });
});

describe("classifyPackages", () => {
  const packages = classifyPackages(parseLockfile(LOCK), ["apps/web"]);
  const byName = Object.fromEntries(packages.map((p) => [p.name, p]));

  it("uses the project document, not the package manager's own lock", () => {
    expect(byName.pnpm).toBeUndefined();
  });

  it("marks a deployable's production closure, through workspace links and aliases", () => {
    expect(byName.zod?.shippedBy).toEqual(["apps/web"]);
    expect(byName["string-width"]?.shippedBy).toEqual(["apps/web"]);
    expect(byName.auth?.shippedBy).toEqual(["apps/web"]);
  });

  it("does not ship a peer that only a dev dependency provides", () => {
    expect(byName.vitest?.shippedBy).toEqual([]);
  });

  it("marks platform packages and what only they pull in as platform-only", () => {
    expect(byName["native-linux-x64"]?.platformOnly).toBe(true);
    expect(byName["wasm-helper"]?.platformOnly).toBe(true);
    expect(byName.native?.platformOnly).toBe(false);
  });
});
