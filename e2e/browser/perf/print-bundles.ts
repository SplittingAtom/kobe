import { readBundleSizes } from "./bundles.ts";

/** `npm run perf:bundles [-- <apps/web dir>]`: first-load JS per route of a local `next build`. */
const sizes = readBundleSizes(process.argv[2] ?? "../../apps/web");
for (const [route, size] of Object.entries(sizes).sort(([a], [b]) => (a < b ? -1 : 1))) {
  const gz = size.gzipBytes === undefined ? "–" : Math.round(size.gzipBytes / 1024);
  console.log(`${route}\t${Math.round(size.rawBytes / 1024)} KB\t${gz} KB gz`);
}
