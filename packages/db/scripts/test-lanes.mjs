#!/usr/bin/env node
// Lists or drops test database lanes on the dev Postgres (KOBE-482; see docs/parallel-work.md).
//   pnpm --filter @kobe/db test:lanes              list lanes with their databases and roles
//   pnpm --filter @kobe/db test:lanes drop <lane>  drop a lane that is not running tests
// Needs KOBE_TEST_DATABASE_URL (the server URL, not a lane database) and a built @kobe/db.
import { dropTestLane, listTestLanes } from "../dist/test-support/database.js";

const url = process.env.KOBE_TEST_DATABASE_URL;
if (!url) {
  console.error("KOBE_TEST_DATABASE_URL is required");
  process.exit(2);
}
const [command = "list", lane] = process.argv.slice(2);
if (command === "list") {
  const lanes = await listTestLanes(url);
  if (lanes.length === 0) console.log("no test lanes");
  for (const l of lanes) console.log(`${l.lane}\tdatabases=${l.databases}\troles=${l.roles}`);
} else if (command === "drop" && lane) {
  const dropped = await dropTestLane(url, lane);
  console.log(`dropped ${dropped.databases.length} databases, ${dropped.roles.length} roles`);
} else {
  console.error("usage: test-lanes.mjs [list | drop <lane>]");
  process.exit(2);
}
