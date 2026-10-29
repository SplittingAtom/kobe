// KOBE-514: better-auth lists framework and tooling packages as optional peers. pnpm links an
// optional peer whenever the workspace has it anywhere (next in apps/web, vitest at the root,
// drizzle-kit in packages/db), so `pnpm deploy --prod` copied them into kobe-server: next and
// @next/swc (~300 MB, plus next's CVEs), drizzle-kit with its bundled esbuild, vitest, vite and
// happy-dom. Kobe uses none of better-auth's integrations for them (the server uses the core API
// and the Drizzle adapter, the web app the React client), so drop just these peers.
const DROPPED_PEERS = {
  "better-auth": ["next", "drizzle-kit", "vitest"],
};

function readPackage(pkg) {
  const dropped = DROPPED_PEERS[pkg.name];
  if (!dropped) return pkg;
  const peerDependencies = { ...pkg.peerDependencies };
  const peerDependenciesMeta = { ...pkg.peerDependenciesMeta };
  for (const name of dropped) {
    delete peerDependencies[name];
    delete peerDependenciesMeta[name];
  }
  return { ...pkg, peerDependencies, peerDependenciesMeta };
}

module.exports = { hooks: { readPackage } };
