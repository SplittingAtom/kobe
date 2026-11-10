// Sends every case to Bifrost and pairs it with what the capture server received upstream.
// Usage (inside the docker network): node drive.mjs cases.json > results.json
// Env: BIFROST_URL (default http://bifrost:8080), CAPTURE_URL (default http://capture:9000).
import { readFileSync } from "node:fs";

const BIFROST = process.env.BIFROST_URL ?? "http://bifrost:8080";
const CAPTURE = process.env.CAPTURE_URL ?? "http://capture:9000";
const cases = JSON.parse(readFileSync(process.argv[2], "utf8"));

const results = [];
for (const c of cases) {
  if (c.refused !== undefined) {
    results.push({ id: c.id, refusedByGateway: c.refused });
    continue;
  }
  await fetch(`${CAPTURE}/__captured`); // clear
  const headers = {
    "content-type": "application/json",
    "user-agent": "pi-capture/1.4.0",
    ...(c.path.startsWith("/anthropic/") ? { "anthropic-version": "2023-06-01" } : {}),
    ...(c.headers ?? {}),
  };
  let status;
  let reply;
  try {
    const res = await fetch(`${BIFROST}${c.path}`, { method: "POST", headers, body: c.body });
    status = res.status;
    reply = (await res.text()).slice(0, 600);
  } catch (err) {
    status = "fetch_error";
    reply = String(err);
  }
  const upstream = await (await fetch(`${CAPTURE}/__captured`)).json();
  results.push({
    id: c.id,
    path: c.path,
    sent: c.body,
    status,
    reply: status === 200 ? undefined : reply,
    upstream: upstream.map((u) => ({ path: u.path, headers: u.headers, body: u.body })),
  });
}
process.stdout.write(JSON.stringify(results, null, 1));
